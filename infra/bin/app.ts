#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { loadStageConfig } from "../lib/config";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { FoundationStack } from "../lib/foundation-stack";
import { MicrovmImageStack } from "../lib/microvm-image-stack";
import { ObservabilityStack } from "../lib/observability-stack";

const app = new App();
const config = loadStageConfig(app);
const env = {
  region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1"
};
const prefix = `SinatraMicrovms-${config.stage}`;

const foundation = new FoundationStack(app, `${prefix}-Foundation`, { config, env });
const image = new MicrovmImageStack(app, `${prefix}-Image`, {
  config,
  env,
  vpcEgressConnectorArn: foundation.vpcEgressConnectorArn
});
const controlPlane = new ControlPlaneStack(app, `${prefix}-ControlPlane`, {
  config,
  env,
  routesTable: foundation.routesTable,
  microvmImageArn: image.imageArn,
  microvmImageVersion: image.imageVersion,
  microvmExecutionRole: image.executionRole,
  vpcEgressConnectorArn: foundation.vpcEgressConnectorArn
});
new ObservabilityStack(app, `${prefix}-Observability`, {
  config,
  env,
  routesTable: foundation.routesTable,
  proxyFunction: controlPlane.proxyFunction,
  reconcilerFunction: controlPlane.reconcilerFunction,
  api: controlPlane.api
});

app.synth();
