import { App, RemovalPolicy } from "aws-cdk-lib";

export type StageName = "dev" | "staging" | "production";

export interface StageConfig {
  readonly stage: StageName;
  readonly production: boolean;
  readonly removalPolicy: RemovalPolicy;
  readonly logRetentionDays: number;
  readonly proxyReservedConcurrency: number;
  readonly reconcilerReservedConcurrency: number;
}

const VALID_STAGES = new Set<StageName>(["dev", "staging", "production"]);

export function loadStageConfig(app: App): StageConfig {
  const value: unknown = app.node.tryGetContext("stage") ?? "dev";
  if (typeof value !== "string" || !VALID_STAGES.has(value as StageName)) {
    throw new Error("CDK context 'stage' must be dev, staging, or production");
  }

  const stage = value as StageName;
  const production = stage === "production";
  return {
    stage,
    production,
    removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    logRetentionDays: production ? 365 : 30,
    proxyReservedConcurrency: production ? 100 : 10,
    reconcilerReservedConcurrency: 1
  };
}
