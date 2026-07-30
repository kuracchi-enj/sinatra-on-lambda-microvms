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
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Architecture, Function, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { CfnWebACL, CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import * as path from "node:path";
import { StageConfig } from "./config";

export interface ControlPlaneStackProps extends StackProps {
  readonly config: StageConfig;
  readonly routesTable: Table;
  readonly microvmImageArn: string;
  readonly microvmImageVersion: string;
  readonly microvmExecutionRole: Role;
  readonly vpcEgressConnectorArn: string;
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
    const ingressConnectorArn =
      `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
    const internetEgressConnectorArn =
      `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
    const egressConnectorArn = config.egressMode === "vpc"
      ? props.vpcEgressConnectorArn
      : internetEgressConnectorArn;
    const bundling = {
      minify: false,
      sourceMap: true,
      format: OutputFormat.CJS,
      externalModules: [] as string[]
    };

    this.proxyFunction = new NodejsFunction(this, "ProxyFunction", {
      architecture: Architecture.ARM_64,
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../runtime/proxy/index.js"),
      handler: "handler",
      description: "Authenticated tenant routing proxy for Sinatra MicroVMs",
      timeout: Duration.seconds(28),
      memorySize: 512,
      reservedConcurrentExecutions: config.proxyReservedConcurrency,
      tracing: Tracing.ACTIVE,
      logGroup: proxyLogs,
      bundling,
      environment: {
        ROUTES_TABLE_NAME: routesTable.tableName,
        STAGE: config.stage,
        MICROVM_IMAGE_ARN: props.microvmImageArn,
        MICROVM_IMAGE_VERSION: props.microvmImageVersion,
        MICROVM_EXECUTION_ROLE_ARN: props.microvmExecutionRole.roleArn,
        INGRESS_CONNECTOR_ARN: ingressConnectorArn,
        EGRESS_CONNECTOR_ARN: egressConnectorArn,
        MAXIMUM_DURATION_SECONDS: String(config.maximumDurationSeconds),
        MAX_IDLE_DURATION_SECONDS: String(config.maxIdleDurationSeconds),
        SUSPENDED_DURATION_SECONDS: String(config.suspendedDurationSeconds),
        HARD_EXPIRY_MARGIN_SECONDS: String(config.hardExpiryMarginSeconds),
        TOKEN_TTL_MINUTES: String(config.tokenTtlMinutes),
        PROVISIONING_WAIT_MILLISECONDS: "10000"
      }
    });
    routesTable.grantReadWriteData(this.proxyFunction);
    this.proxyFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:CreateMicrovmAuthToken",
        "lambda:TerminateMicrovm"
      ],
      resources: [
        props.microvmImageArn,
        `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:microvm:*`
      ]
    }));
    props.microvmExecutionRole.grantPassRole(this.proxyFunction.grantPrincipal);

    const reconcilerLogs = new LogGroup(this, "ReconcilerLogs", {
      retention,
      removalPolicy: config.removalPolicy
    });
    this.reconcilerFunction = new NodejsFunction(this, "ReconcilerFunction", {
      architecture: Architecture.ARM_64,
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../runtime/reconciler/index.js"),
      handler: "handler",
      description: "Reconciles expired or stuck Sinatra MicroVM route records",
      timeout: Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: config.reconcilerReservedConcurrency,
      tracing: Tracing.ACTIVE,
      logGroup: reconcilerLogs,
      bundling,
      environment: {
        ROUTES_TABLE_NAME: routesTable.tableName,
        STAGE: config.stage,
        MICROVM_IMAGE_ARN: props.microvmImageArn,
        MICROVM_IMAGE_VERSION: props.microvmImageVersion,
        MICROVM_EXECUTION_ROLE_ARN: props.microvmExecutionRole.roleArn,
        INGRESS_CONNECTOR_ARN: ingressConnectorArn,
        EGRESS_CONNECTOR_ARN: egressConnectorArn,
        MAXIMUM_DURATION_SECONDS: String(config.maximumDurationSeconds),
        MAX_IDLE_DURATION_SECONDS: String(config.maxIdleDurationSeconds),
        SUSPENDED_DURATION_SECONDS: String(config.suspendedDurationSeconds),
        HARD_EXPIRY_MARGIN_SECONDS: String(config.hardExpiryMarginSeconds),
        PROVISIONING_LEASE_GRACE_SECONDS: "60"
      }
    });
    routesTable.grantReadWriteData(this.reconcilerFunction);
    this.reconcilerFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["lambda:RunMicrovm", "lambda:GetMicrovm", "lambda:TerminateMicrovm"],
      resources: [
        props.microvmImageArn,
        `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:microvm:*`
      ]
    }));
    props.microvmExecutionRole.grantPassRole(this.reconcilerFunction.grantPrincipal);

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
