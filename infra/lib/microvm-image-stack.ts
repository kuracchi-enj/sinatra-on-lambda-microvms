import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import * as path from "node:path";
import { StageConfig } from "./config";

export interface MicrovmImageStackProps extends StackProps {
  readonly config: StageConfig;
}

export class MicrovmImageStack extends Stack {
  public constructor(scope: Construct, id: string, props: MicrovmImageStackProps) {
    super(scope, id, props);

    const source = new Asset(this, "ApplicationSource", {
      path: path.resolve(__dirname, "../.."),
      exclude: [".git/**", "infra/**", "vendor/**"]
    });

    new CfnOutput(this, "ApplicationSourceBucket", { value: source.s3BucketName });
    new CfnOutput(this, "ApplicationSourceKey", { value: source.s3ObjectKey });
    new CfnOutput(this, "ApplicationSourceHash", { value: source.assetHash });
    new CfnOutput(this, "MicrovmProviderStatus", {
      value: "BLOCKED_UNTIL_OFFICIAL_CLOUDFORMATION_OR_SDK_MODEL_IS_VERIFIED",
      description: `MicroVM image provider status for ${props.config.stage}`
    });
  }
}
