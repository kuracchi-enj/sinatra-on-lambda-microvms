import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { StageConfig } from "./config";

export interface FoundationStackProps extends StackProps {
  readonly config: StageConfig;
}

export class FoundationStack extends Stack {
  public readonly routesTable: Table;
  public readonly artifactBucket: Bucket;

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

    new CfnOutput(this, "RoutesTableName", { value: this.routesTable.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: this.artifactBucket.bucketName });
    new CfnOutput(this, "DataKeyArn", { value: key.keyArn });
  }
}
