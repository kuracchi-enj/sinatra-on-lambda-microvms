import { Aws, CfnOutput, Duration, Fn, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { IpAddresses, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { CfnNetworkConnector } from "aws-cdk-lib/aws-lambda";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { StageConfig } from "./config";

export interface FoundationStackProps extends StackProps {
  readonly config: StageConfig;
}

export class FoundationStack extends Stack {
  public readonly routesTable: Table;
  public readonly artifactBucket: Bucket;
  public readonly vpc: Vpc;
  public readonly vpcEgressConnectorArn: string;

  public constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { config } = props;

    const key = new Key(this, "DataKey", {
      alias: `alias/sinatra-microvms-${config.stage}`,
      description: `Durable data key for the ${config.stage} Sinatra MicroVM environment`,
      enableKeyRotation: true,
      removalPolicy: config.removalPolicy,
      pendingWindow: Duration.days(30)
    });

    this.routesTable = new Table(this, "RoutesTable", {
      partitionKey: { name: "tenant_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: config.production,
      removalPolicy: config.removalPolicy
    });

    this.artifactBucket = new Bucket(this, "ArtifactBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.KMS,
      encryptionKey: key,
      enforceSSL: true,
      versioned: true,
      removalPolicy: config.removalPolicy,
      autoDeleteObjects: !config.production
    });

    this.vpc = new Vpc(this, "WorkloadVpc", {
      ipAddresses: IpAddresses.cidr("10.42.0.0/16"),
      availabilityZones: [Fn.select(0, Fn.getAzs()), Fn.select(1, Fn.getAzs())],
      natGateways: 0,
      subnetConfiguration: [{
        name: "microvm-egress",
        subnetType: SubnetType.PRIVATE_ISOLATED,
        cidrMask: 24
      }]
    });
    const connectorSecurityGroup = new SecurityGroup(this, "MicrovmEgressSecurityGroup", {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: "Outbound rules for Lambda MicroVM VPC egress"
    });
    const connectorRole = new Role(this, "NetworkConnectorOperatorRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Creates Lambda Network Connector managed ENIs"
    });
    connectorRole.addToPolicy(new PolicyStatement({
      sid: "CreateManagedEni",
      effect: Effect.ALLOW,
      actions: ["ec2:CreateNetworkInterface"],
      resources: [
        `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:network-interface/*`,
        `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:subnet/*`,
        `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:security-group/*`
      ]
    }));
    connectorRole.addToPolicy(new PolicyStatement({
      sid: "TagManagedEni",
      effect: Effect.ALLOW,
      actions: ["ec2:CreateTags"],
      resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:network-interface/*`],
      conditions: {
        StringEquals: {
          "ec2:ManagedResourceOperator": "network-connectors.lambda.amazonaws.com"
        }
      }
    }));
    const connector = new CfnNetworkConnector(this, "VpcEgressConnector", {
      name: `sinatra-microvms-${config.stage}`,
      operatorRole: connectorRole.roleArn,
      configuration: {
        vpcEgressConfiguration: {
          associatedComputeResourceTypes: ["MicroVm"],
          networkProtocol: "IPv4",
          securityGroupIds: [connectorSecurityGroup.securityGroupId],
          subnetIds: this.vpc.isolatedSubnets.map((subnet) => subnet.subnetId)
        }
      },
      tags: [{ key: "Stage", value: config.stage }]
    });
    this.vpcEgressConnectorArn = connector.attrArn;

    new CfnOutput(this, "RoutesTableName", { value: this.routesTable.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: this.artifactBucket.bucketName });
    new CfnOutput(this, "DataKeyArn", { value: key.keyArn });
    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new CfnOutput(this, "VpcEgressConnectorArn", { value: this.vpcEgressConnectorArn });
  }
}
