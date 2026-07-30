import { Aws, CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnMicrovmImage } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import * as path from "node:path";
import { StageConfig } from "./config";

export interface MicrovmImageStackProps extends StackProps {
  readonly config: StageConfig;
  readonly vpcEgressConnectorArn: string;
}

function lambdaServiceRole(scope: Construct, id: string, description: string): Role {
  const service = new ServicePrincipal("lambda.amazonaws.com");
  const role = new Role(scope, id, { assumedBy: service, description });
  role.assumeRolePolicy?.addStatements(new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["sts:TagSession"],
    principals: [service]
  }));
  return role;
}

export class MicrovmImageStack extends Stack {
  public readonly imageArn: string;
  public readonly imageVersion: string;
  public readonly executionRole: Role;

  public constructor(scope: Construct, id: string, props: MicrovmImageStackProps) {
    super(scope, id, props);
    const { config } = props;
    const source = new Asset(this, "ApplicationSource", {
      path: path.resolve(__dirname, "../.."),
      exclude: [
        ".git/**",
        "infra/**",
        "test/**",
        "vendor/**",
        "README.md",
        "SEARCH.md",
        "SPEC.md",
        "Rakefile"
      ]
    });

    const logs = new LogGroup(this, "MicrovmLogs", {
      logGroupName: `/aws/lambda/microvms/sinatra-${config.stage}`,
      retention: config.production ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: config.removalPolicy
    });
    const buildRole = lambdaServiceRole(
      this,
      "ImageBuildRole",
      "Reads the Sinatra source asset and writes Lambda MicroVM image build logs"
    );
    source.grantRead(buildRole);
    logs.grantWrite(buildRole);

    this.executionRole = lambdaServiceRole(
      this,
      "MicrovmExecutionRole",
      "Runtime permissions for tenant Sinatra MicroVMs"
    );
    logs.grantWrite(this.executionRole);

    const internetEgressConnectorArn =
      `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
    const egressConnectorArn = config.egressMode === "vpc"
      ? props.vpcEgressConnectorArn
      : internetEgressConnectorArn;
    const image = new CfnMicrovmImage(this, "SinatraImage", {
      name: `sinatra-microvms-${config.stage}`,
      description: `Sinatra/Puma ARM64 image for ${config.stage}`,
      baseImageArn: `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:aws:microvm-image:al2023-1`,
      baseImageVersion: config.microvmBaseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: {
        uri: `s3://${source.s3BucketName}/${source.s3ObjectKey}`
      },
      cpuConfigurations: [{ architecture: "ARM_64" }],
      resources: [{ minimumMemoryInMiB: config.microvmMemoryMiB }],
      additionalOsCapabilities: [],
      egressNetworkConnectors: [egressConnectorArn],
      environmentVariables: [],
      hooks: {
        port: 8080,
        microvmImageHooks: {
          ready: "ENABLED",
          readyTimeoutInSeconds: 120,
          validate: "ENABLED",
          validateTimeoutInSeconds: 120
        },
        microvmHooks: {
          run: "ENABLED",
          runTimeoutInSeconds: 60,
          suspend: "ENABLED",
          suspendTimeoutInSeconds: 20,
          resume: "ENABLED",
          resumeTimeoutInSeconds: 30,
          terminate: "ENABLED",
          terminateTimeoutInSeconds: 30
        }
      },
      logging: {
        cloudWatch: { logGroup: logs.logGroupName }
      },
      tags: [{ key: "Stage", value: config.stage }]
    });
    image.applyRemovalPolicy(config.removalPolicy);

    this.imageArn = image.attrImageArn;
    this.imageVersion = image.attrLatestActiveImageVersion;

    new CfnOutput(this, "ApplicationSourceBucket", { value: source.s3BucketName });
    new CfnOutput(this, "ApplicationSourceKey", { value: source.s3ObjectKey });
    new CfnOutput(this, "ApplicationSourceHash", { value: source.assetHash });
    new CfnOutput(this, "MicrovmImageArn", { value: this.imageArn });
    new CfnOutput(this, "MicrovmImageVersion", { value: this.imageVersion });
    new CfnOutput(this, "MicrovmExecutionRoleArn", { value: this.executionRole.roleArn });
  }
}
