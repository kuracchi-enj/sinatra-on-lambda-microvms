import { App, RemovalPolicy } from "aws-cdk-lib";

export type StageName = "dev" | "staging" | "production";
export type MicrovmEgressMode = "internet" | "vpc";

export interface StageConfig {
  readonly stage: StageName;
  readonly production: boolean;
  readonly removalPolicy: RemovalPolicy;
  readonly logRetentionDays: number;
  readonly proxyReservedConcurrency: number;
  readonly reconcilerReservedConcurrency: number;
  readonly microvmBaseImageVersion: string;
  readonly microvmMemoryMiB: number;
  readonly maximumDurationSeconds: number;
  readonly maxIdleDurationSeconds: number;
  readonly suspendedDurationSeconds: number;
  readonly hardExpiryMarginSeconds: number;
  readonly tokenTtlMinutes: number;
  readonly egressMode: MicrovmEgressMode;
}

const VALID_STAGES = new Set<StageName>(["dev", "staging", "production"]);
const VALID_EGRESS_MODES = new Set<MicrovmEgressMode>(["internet", "vpc"]);

function integerContext(app: App, key: string, fallback: number, minimum: number, maximum: number): number {
  const value: unknown = app.node.tryGetContext(key) ?? fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`CDK context '${key}' must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function loadStageConfig(app: App): StageConfig {
  const value: unknown = app.node.tryGetContext("stage") ?? "dev";
  if (typeof value !== "string" || !VALID_STAGES.has(value as StageName)) {
    throw new Error("CDK context 'stage' must be dev, staging, or production");
  }

  const stage = value as StageName;
  const production = stage === "production";
  const egressValue: unknown = app.node.tryGetContext("microvmEgressMode") ?? "internet";
  if (typeof egressValue !== "string" || !VALID_EGRESS_MODES.has(egressValue as MicrovmEgressMode)) {
    throw new Error("CDK context 'microvmEgressMode' must be internet or vpc");
  }
  const microvmBaseImageVersion: unknown = app.node.tryGetContext("microvmBaseImageVersion") ?? "0";
  if (typeof microvmBaseImageVersion !== "string" || microvmBaseImageVersion.length === 0) {
    throw new Error("CDK context 'microvmBaseImageVersion' must be a non-empty string");
  }
  const maximumDurationSeconds = integerContext(app, "maximumDurationSeconds", 3600, 1, 28_800);
  const hardExpiryMarginSeconds = integerContext(app, "hardExpiryMarginSeconds", 600, 1, 3600);
  if (hardExpiryMarginSeconds >= maximumDurationSeconds) {
    throw new Error("CDK context 'hardExpiryMarginSeconds' must be less than maximumDurationSeconds");
  }

  return {
    stage,
    production,
    removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    logRetentionDays: production ? 365 : 30,
    proxyReservedConcurrency: production ? 100 : 10,
    reconcilerReservedConcurrency: 1,
    microvmBaseImageVersion,
    microvmMemoryMiB: integerContext(app, "microvmMemoryMiB", 512, 512, 8192),
    maximumDurationSeconds,
    maxIdleDurationSeconds: integerContext(app, "maxIdleDurationSeconds", 300, 1, 28_800),
    suspendedDurationSeconds: integerContext(app, "suspendedDurationSeconds", 1800, 1, 28_800),
    hardExpiryMarginSeconds,
    tokenTtlMinutes: integerContext(app, "tokenTtlMinutes", 5, 1, 60),
    egressMode: egressValue as MicrovmEgressMode
  };
}
