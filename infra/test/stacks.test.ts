import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { StageConfig } from "../lib/config";
import { FoundationStack } from "../lib/foundation-stack";
import { MicrovmImageStack } from "../lib/microvm-image-stack";
import { ObservabilityStack } from "../lib/observability-stack";

function config(stage: "dev" | "production"): StageConfig {
  const production = stage === "production";
  return {
    stage,
    production,
    removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    logRetentionDays: production ? 365 : 30,
    proxyReservedConcurrency: production ? 100 : 10,
    reconcilerReservedConcurrency: 1,
    microvmBaseImageVersion: "0",
    microvmMemoryMiB: 512,
    maximumDurationSeconds: 3600,
    maxIdleDurationSeconds: 300,
    suspendedDurationSeconds: 1800,
    hardExpiryMarginSeconds: 600,
    tokenTtlMinutes: 5,
    egressMode: "internet"
  };
}

function stacks(stage: "dev" | "production" = "dev"): {
  foundation: FoundationStack;
  control: ControlPlaneStack;
  image: MicrovmImageStack;
  observability: ObservabilityStack;
} {
  const app = new App();
  const stageConfig = config(stage);
  const foundation = new FoundationStack(app, "Foundation", { config: stageConfig });
  const image = new MicrovmImageStack(app, "Image", {
    config: stageConfig,
    vpcEgressConnectorArn: foundation.vpcEgressConnectorArn
  });
  const control = new ControlPlaneStack(app, "Control", {
    config: stageConfig,
    routesTable: foundation.routesTable,
    microvmImageArn: image.imageArn,
    microvmImageVersion: image.imageVersion,
    microvmExecutionRole: image.executionRole,
    vpcEgressConnectorArn: foundation.vpcEgressConnectorArn
  });
  const observability = new ObservabilityStack(app, "Observability", {
    config: stageConfig,
    routesTable: foundation.routesTable,
    proxyFunction: control.proxyFunction,
    reconcilerFunction: control.reconcilerFunction,
    api: control.api
  });
  return { foundation, control, image, observability };
}

test("foundation encrypts and protects durable resources", () => {
  const template = Template.fromStack(stacks("production").foundation);
  template.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
    Properties: Match.objectLike({
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: "KMS" })
    })
  });
  template.hasResourceProperties("AWS::S3::Bucket", {
    BucketEncryption: Match.anyValue(),
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    },
    VersioningConfiguration: { Status: "Enabled" }
  });
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Effect: "Deny",
        Condition: { Bool: { "aws:SecureTransport": "false" } }
      })])
    })
  });
  template.resourceCountIs("AWS::EC2::VPC", 1);
  template.hasResourceProperties("AWS::Lambda::NetworkConnector", {
    Configuration: {
      VpcEgressConfiguration: Match.objectLike({
        AssociatedComputeResourceTypes: ["MicroVm"],
        NetworkProtocol: "IPv4"
      })
    }
  });
});

test("control plane has bounded arm64 functions, auth, schedule and DLQ", () => {
  const template = Template.fromStack(stacks().control);
  template.resourceCountIs("AWS::Lambda::Function", 2);
  template.allResourcesProperties("AWS::Lambda::Function", Match.objectLike({
    Architectures: ["arm64"],
    Runtime: "nodejs22.x",
    TracingConfig: { Mode: "Active" },
    ReservedConcurrentExecutions: Match.anyValue(),
    Timeout: Match.anyValue()
  }));
  template.hasResourceProperties("AWS::ApiGateway::Authorizer", { Type: "COGNITO_USER_POOLS" });
  template.hasResourceProperties("AWS::WAFv2::WebACL", {
    Scope: "REGIONAL",
    Rules: Match.arrayWith([Match.objectLike({ Name: "PerIpRateLimit" })])
  });
  template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(1 minute)" });
  template.hasResourceProperties("AWS::SQS::Queue", {
    KmsMasterKeyId: "alias/aws/sqs",
    MessageRetentionPeriod: 1209600
  });
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:UpdateItem"]),
        Effect: "Allow"
      })]),
      Version: "2012-10-17"
    }
  });
});

test("observability creates alarms, dashboard, and notification topic", () => {
  const template = Template.fromStack(stacks().observability);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 3);
  template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  template.resourceCountIs("AWS::SNS::Topic", 1);
});

test("image stack publishes a content-addressed source asset without an invented provider", () => {
  const template = Template.fromStack(stacks().image);
  template.resourceCountIs("Custom::AWS", 0);
  template.hasOutput("ApplicationSourceHash", {});
  template.hasResourceProperties("AWS::Lambda::MicrovmImage", {
    BaseImageVersion: "0",
    CpuConfigurations: [{ Architecture: "ARM_64" }],
    AdditionalOsCapabilities: [],
    EgressNetworkConnectors: [
      { "Fn::Join": Match.anyValue() }
    ],
    Resources: [{ MinimumMemoryInMiB: 512 }],
    Hooks: Match.objectLike({
      Port: 8080,
      MicrovmHooks: Match.objectLike({
        Run: "ENABLED",
        Suspend: "ENABLED",
        Resume: "ENABLED",
        Terminate: "ENABLED"
      })
    })
  });
});

test("stacks do not attach administrator managed policies", () => {
  const appStacks: Stack[] = Object.values(stacks());
  for (const stack of appStacks) {
    const json = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(json).not.toContain("AdministratorAccess");
  }
});
