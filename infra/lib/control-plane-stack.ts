import { Aws, CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  LambdaIntegration,
  RestApi,
  MethodLoggingLevel
} from "aws-cdk-lib/aws-apigateway";
import { StringAttribute, UserPool, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, Code, Function, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { CfnWebACL, CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { StageConfig } from "./config";

export interface ControlPlaneStackProps extends StackProps {
  readonly config: StageConfig;
  readonly routesTable: Table;
}

export class ControlPlaneStack extends Stack {
  public readonly proxyFunction: Function;
  public readonly reconcilerFunction: Function;
  public readonly api: RestApi;

  public constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);
    const { config, routesTable } = props;
    const retention = config.production ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH;

    const proxyLogs = new LogGroup(this, "ProxyLogs", {
      retention,
      removalPolicy: config.removalPolicy
    });
    this.proxyFunction = new Function(this, "ProxyFunction", {
      architecture: Architecture.ARM_64,
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset("runtime/proxy"),
      description: "Authenticated tenant routing proxy for Sinatra MicroVMs",
      timeout: Duration.seconds(120),
      memorySize: 512,
      reservedConcurrentExecutions: config.proxyReservedConcurrency,
      tracing: Tracing.ACTIVE,
      logGroup: proxyLogs,
      environment: {
        ROUTES_TABLE_NAME: routesTable.tableName,
        STAGE: config.stage
      }
    });
    routesTable.grantReadWriteData(this.proxyFunction);

    const reconcilerLogs = new LogGroup(this, "ReconcilerLogs", {
      retention,
      removalPolicy: config.removalPolicy
    });
    this.reconcilerFunction = new Function(this, "ReconcilerFunction", {
      architecture: Architecture.ARM_64,
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromAsset("runtime/reconciler"),
      description: "Reconciles expired or stuck Sinatra MicroVM route records",
      timeout: Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: config.reconcilerReservedConcurrency,
      tracing: Tracing.ACTIVE,
      logGroup: reconcilerLogs,
      environment: {
        ROUTES_TABLE_NAME: routesTable.tableName,
        STAGE: config.stage,
        PROVISIONING_LEASE_GRACE_SECONDS: "60"
      }
    });
    routesTable.grantReadWriteData(this.reconcilerFunction);

    new Rule(this, "ReconcileSchedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(this.reconcilerFunction, {
        deadLetterQueue: new Queue(this, "ReconcilerDlq", {
          encryption: QueueEncryption.KMS_MANAGED,
          enforceSSL: true,
          retentionPeriod: Duration.days(14)
        }),
        retryAttempts: 2,
        maxEventAge: Duration.minutes(5)
      })]
    });

    const userPool = new UserPool(this, "Users", {
      selfSignUpEnabled: false,
      customAttributes: {
        tenant_id: new StringAttribute({ minLen: 1, maxLen: 128, mutable: false })
      },
      removalPolicy: config.removalPolicy
    });
    const userPoolClient = new UserPoolClient(this, "UsersClient", {
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true }
    });
    const authorizer = new CognitoUserPoolsAuthorizer(this, "Authorizer", {
      cognitoUserPools: [userPool]
    });

    this.api = new RestApi(this, "PublicApi", {
      description: `Authenticated Sinatra MicroVM proxy (${config.stage})`,
      deployOptions: {
        stageName: config.stage,
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: MethodLoggingLevel.INFO,
        dataTraceEnabled: false
      },
      cloudWatchRole: true
    });
    const integration = new LambdaIntegration(this.proxyFunction, { proxy: true });
    const methodOptions = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer
    };
    this.api.root.addMethod("ANY", integration, methodOptions);
    this.api.root.addProxy({
      anyMethod: true,
      defaultIntegration: integration,
      defaultMethodOptions: methodOptions
    });

    const webAcl = new CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `sinatra-microvms-${config.stage}`,
        sampledRequestsEnabled: true
      },
      rules: [{
        name: "PerIpRateLimit",
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            aggregateKeyType: "IP",
            limit: config.production ? 2_000 : 500
          }
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `sinatra-microvms-${config.stage}-rate-limit`,
          sampledRequestsEnabled: true
        }
      }]
    });
    new CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: `arn:${Aws.PARTITION}:apigateway:${Aws.REGION}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
      webAclArn: webAcl.attrArn
    });

    new CfnOutput(this, "ApiUrl", { value: this.api.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
  }
}
