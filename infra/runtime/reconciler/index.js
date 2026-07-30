"use strict";

const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand
} = require("@aws-sdk/client-lambda-microvms");
const crypto = require("node:crypto");

const dynamodb = new DynamoDBClient({});
const microvms = new LambdaMicrovmsClient({});
const tableName = process.env.ROUTES_TABLE_NAME;
const imageArn = process.env.MICROVM_IMAGE_ARN;
const imageVersion = process.env.MICROVM_IMAGE_VERSION;
const executionRoleArn = process.env.MICROVM_EXECUTION_ROLE_ARN;
const ingressConnectorArn = process.env.INGRESS_CONNECTOR_ARN;
const egressConnectorArn = process.env.EGRESS_CONNECTOR_ARN;
const maximumDurationSeconds = Number(process.env.MAXIMUM_DURATION_SECONDS || 3600);
const maxIdleDurationSeconds = Number(process.env.MAX_IDLE_DURATION_SECONDS || 300);
const suspendedDurationSeconds = Number(process.env.SUSPENDED_DURATION_SECONDS || 1800);
const hardExpiryMarginSeconds = Number(process.env.HARD_EXPIRY_MARGIN_SECONDS || 600);
const leaseGraceSeconds = Number(process.env.PROVISIONING_LEASE_GRACE_SECONDS || 60);
const leaseSeconds = 120;

function tenantHash(tenantId) {
  return crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

function clientToken(tenantId, generation) {
  return crypto.createHash("sha256").update(`${tenantId}:${generation}`).digest("hex");
}

function shouldRotate(item, nowMilliseconds) {
  const expiresAt = Date.parse(item.hard_expires_at?.S || "");
  return Number.isFinite(expiresAt) && expiresAt <= nowMilliseconds;
}

function conditionalFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

function notFound(error) {
  return error?.name === "ResourceNotFoundException";
}

async function setState(item, state, removeRuntime = false) {
  const remove = removeRuntime
    ? " REMOVE lease_owner, lease_expires_at, microvm_id, endpoint"
    : " REMOVE lease_owner, lease_expires_at";
  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenant_id: item.tenant_id },
    UpdateExpression: `SET #state = :state${remove} ADD version :one`,
    ConditionExpression: "generation = :generation AND version = :version",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":state": { S: state },
      ":generation": item.generation || { N: "0" },
      ":version": item.version || { N: "0" },
      ":one": { N: "1" }
    }
  }));
}

async function clearDraining(item) {
  if (!item.draining_microvm_id?.S) return false;
  const removeReference = async () => {
    await dynamodb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { tenant_id: item.tenant_id },
      UpdateExpression: "REMOVE draining_microvm_id",
      ConditionExpression: "generation = :generation AND draining_microvm_id = :draining",
      ExpressionAttributeValues: {
        ":generation": item.generation || { N: "0" },
        ":draining": item.draining_microvm_id
      }
    }));
  };
  try {
    await microvms.send(new TerminateMicrovmCommand({
      microvmIdentifier: item.draining_microvm_id.S
    }));
    await removeReference();
    return true;
  } catch (error) {
    if (notFound(error)) {
      try {
        await removeReference();
        return true;
      } catch (updateError) {
        if (conditionalFailure(updateError)) return false;
        throw updateError;
      }
    }
    if (conditionalFailure(error)) return false;
    throw error;
  }
}

async function beginRotation(item, requestId, nowMilliseconds) {
  const tenantId = item.tenant_id.S;
  const currentGeneration = Number(item.generation?.N || 0);
  const nextGeneration = currentGeneration + 1;
  const now = new Date(nowMilliseconds);
  const leaseExpiresAt = Math.floor(nowMilliseconds / 1000) + leaseSeconds;
  const hardExpiresAt =
    new Date(nowMilliseconds + (maximumDurationSeconds - hardExpiryMarginSeconds) * 1000).toISOString();
  const platformExpiresAt =
    new Date(nowMilliseconds + maximumDurationSeconds * 1000).toISOString();

  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenant_id: item.tenant_id },
    UpdateExpression:
      "SET generation = :next_generation, #state = :provisioning, image_version = :image, " +
      "lease_owner = :owner, lease_expires_at = :lease, created_at = :now, last_access_at = :now, " +
      "hard_expires_at = :hard, platform_expires_at = :platform, draining_microvm_id = :draining " +
      "REMOVE microvm_id, endpoint ADD version :one",
    ConditionExpression:
      "generation = :generation AND version = :version AND hard_expires_at <= :now " +
      "AND (#state = :running OR #state = :suspended)",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":next_generation": { N: String(nextGeneration) },
      ":provisioning": { S: "PROVISIONING" },
      ":image": { S: imageVersion },
      ":owner": { S: requestId },
      ":lease": { N: String(leaseExpiresAt) },
      ":now": { S: now.toISOString() },
      ":hard": { S: hardExpiresAt },
      ":platform": { S: platformExpiresAt },
      ":draining": item.microvm_id,
      ":generation": item.generation || { N: "0" },
      ":version": item.version || { N: "0" },
      ":running": { S: "RUNNING" },
      ":suspended": { S: "SUSPENDED" },
      ":one": { N: "1" }
    }
  }));

  const launched = await microvms.send(new RunMicrovmCommand({
    imageIdentifier: imageArn,
    imageVersion,
    executionRoleArn,
    ingressNetworkConnectors: [ingressConnectorArn],
    egressNetworkConnectors: [egressConnectorArn],
    idlePolicy: {
      autoResumeEnabled: true,
      maxIdleDurationSeconds,
      suspendedDurationSeconds
    },
    maximumDurationInSeconds: maximumDurationSeconds,
    runHookPayload: JSON.stringify({ generation: nextGeneration }),
    clientToken: clientToken(tenantId, nextGeneration)
  }));
  const startedAt = launched.startedAt instanceof Date ? launched.startedAt : now;
  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenant_id: item.tenant_id },
    UpdateExpression:
      "SET microvm_id = :microvm, endpoint = :endpoint, hard_expires_at = :hard, " +
      "platform_expires_at = :platform ADD version :one",
    ConditionExpression: "generation = :generation AND lease_owner = :owner",
    ExpressionAttributeValues: {
      ":microvm": { S: launched.microvmId },
      ":endpoint": { S: launched.endpoint },
      ":hard": {
        S: new Date(
          startedAt.getTime() + (maximumDurationSeconds - hardExpiryMarginSeconds) * 1000
        ).toISOString()
      },
      ":platform": {
        S: new Date(startedAt.getTime() + maximumDurationSeconds * 1000).toISOString()
      },
      ":generation": { N: String(nextGeneration) },
      ":owner": { S: requestId },
      ":one": { N: "1" }
    }
  }));
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "INFO",
    service: "reconciler",
    event: "rotation.started",
    request_id: requestId,
    tenant_hash: tenantHash(tenantId),
    microvm_id: launched.microvmId,
    generation: nextGeneration,
    lifecycle_state: launched.state,
    outcome: "success"
  }));
  return { action: "rotation_started" };
}

async function reconcileProvisioning(item, now) {
  if (!item.microvm_id?.S) {
    const leaseExpired =
      Number(item.lease_expires_at?.N || 0) + leaseGraceSeconds < now;
    return { action: leaseExpired ? "lease_available_for_takeover" : "pending" };
  }

  try {
    const remote = await microvms.send(new GetMicrovmCommand({
      microvmIdentifier: item.microvm_id.S
    }));
    if (remote.state === "RUNNING") {
      await setState(item, "RUNNING");
      await clearDraining(item);
      return { action: "marked_running" };
    }
    if (remote.state === "TERMINATED" || remote.state === "TERMINATING") {
      await setState(item, "FAILED", true);
      return { action: "marked_failed" };
    }
    return { action: "pending" };
  } catch (error) {
    if (notFound(error)) {
      await setState(item, "FAILED", true);
      return { action: "marked_failed" };
    }
    throw error;
  }
}

async function reconcileActive(item, nowMilliseconds, requestId) {
  if (!item.microvm_id?.S) {
    await setState(item, "FAILED", true);
    return { action: "marked_failed" };
  }
  if (shouldRotate(item, nowMilliseconds)) {
    return beginRotation(item, requestId, nowMilliseconds);
  }

  try {
    const remote = await microvms.send(new GetMicrovmCommand({
      microvmIdentifier: item.microvm_id.S
    }));
    if (remote.state === "RUNNING" || remote.state === "SUSPENDED") {
      const desiredState = remote.state;
      if (item.state?.S !== desiredState) await setState(item, desiredState);
      await clearDraining(item);
      return { action: item.state?.S === desiredState ? "unchanged" : `marked_${desiredState.toLowerCase()}` };
    }
    if (remote.state === "TERMINATING" || remote.state === "TERMINATED") {
      await setState(item, "FAILED", true);
      return { action: "marked_failed" };
    }
    return { action: "unchanged" };
  } catch (error) {
    if (notFound(error)) {
      await setState(item, "FAILED", true);
      return { action: "marked_failed" };
    }
    throw error;
  }
}

exports.handler = async function handler(_event, context) {
  const nowMilliseconds = Date.now();
  const now = Math.floor(nowMilliseconds / 1000);
  let lastEvaluatedKey;
  const totals = {};

  do {
    const page = await dynamodb.send(new ScanCommand({
      TableName: tableName,
      ProjectionExpression:
        "tenant_id, #state, generation, microvm_id, draining_microvm_id, " +
        "lease_expires_at, hard_expires_at, version",
      ExpressionAttributeNames: { "#state": "state" },
      ExclusiveStartKey: lastEvaluatedKey
    }));
    for (const item of page.Items || []) {
      try {
        const state = item.state?.S;
        let result = { action: "ignored" };
        if (state === "PROVISIONING") result = await reconcileProvisioning(item, now);
        else if (state === "RUNNING" || state === "SUSPENDED") {
          result = await reconcileActive(item, nowMilliseconds, context.awsRequestId);
        }
        totals[result.action] = (totals[result.action] || 0) + 1;
      } catch (error) {
        if (conditionalFailure(error)) {
          totals.concurrent_update = (totals.concurrent_update || 0) + 1;
          continue;
        }
        console.error(JSON.stringify({
          event: "reconcile.route_failed",
          request_id: context.awsRequestId,
          error_code: error?.name || "UnknownError"
        }));
        totals.failed = (totals.failed || 0) + 1;
      }
    }
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "INFO",
    service: "reconciler",
    event: "reconcile.complete",
    request_id: context.awsRequestId,
    outcome: totals.failed ? "partial" : "success",
    ...totals
  }));
  return totals;
};

exports._private = { clientToken, shouldRotate };
