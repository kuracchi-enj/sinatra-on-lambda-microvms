"use strict";

const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand
} = require("@aws-sdk/client-dynamodb");
const {
  CreateMicrovmAuthTokenCommand,
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
const tokenTtlMinutes = Number(process.env.TOKEN_TTL_MINUTES || 5);
const provisioningWaitMilliseconds = Number(process.env.PROVISIONING_WAIT_MILLISECONDS || 10000);
const leaseSeconds = 120;
const tokenCache = new Map();
const requestIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const idempotentMethods = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const forwardedRequestHeaders = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "cookie",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "user-agent"
]);
const forwardedResponseHeaders = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "location"
]);

function nowIso() {
  return new Date().toISOString();
}

function routeFromItem(item) {
  if (!item) return undefined;
  return {
    tenantId: item.tenant_id?.S,
    generation: Number(item.generation?.N || 0),
    microvmId: item.microvm_id?.S,
    endpoint: item.endpoint?.S,
    state: item.state?.S,
    imageVersion: item.image_version?.S,
    leaseOwner: item.lease_owner?.S,
    leaseExpiresAt: Number(item.lease_expires_at?.N || 0),
    hardExpiresAt: item.hard_expires_at?.S,
    platformExpiresAt: item.platform_expires_at?.S,
    drainingMicrovmId: item.draining_microvm_id?.S,
    version: Number(item.version?.N || 0)
  };
}

function response(statusCode, requestId, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-request-id": requestId,
      ...headers
    },
    body: JSON.stringify({ ...body, request_id: requestId })
  };
}

function conditionalFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

function requestIdFor(event, context) {
  const supplied = event.headers?.["X-Request-Id"] || event.headers?.["x-request-id"];
  return requestIdPattern.test(String(supplied || "")) ? supplied : context.awsRequestId;
}

function tenantHash(tenantId) {
  return crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

function clientToken(tenantId, generation) {
  return crypto.createHash("sha256").update(`${tenantId}:${generation}`).digest("hex");
}

function serviceErrorName(error) {
  return typeof error?.name === "string" ? error.name : "UnknownError";
}

async function getRoute(tenantId) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: tableName,
    Key: { tenant_id: { S: tenantId } },
    ConsistentRead: true
  }));
  return routeFromItem(result.Item);
}

async function createInitialLease(tenantId, requestId) {
  const now = new Date();
  const route = {
    tenantId,
    generation: 1,
    state: "PROVISIONING",
    imageVersion,
    leaseOwner: requestId,
    leaseExpiresAt: Math.floor(now.getTime() / 1000) + leaseSeconds,
    hardExpiresAt: new Date(now.getTime() + (maximumDurationSeconds - hardExpiryMarginSeconds) * 1000).toISOString(),
    platformExpiresAt: new Date(now.getTime() + maximumDurationSeconds * 1000).toISOString(),
    version: 1
  };
  await dynamodb.send(new PutItemCommand({
    TableName: tableName,
    Item: {
      tenant_id: { S: tenantId },
      generation: { N: "1" },
      state: { S: "PROVISIONING" },
      image_version: { S: imageVersion },
      lease_owner: { S: requestId },
      lease_expires_at: { N: String(route.leaseExpiresAt) },
      created_at: { S: now.toISOString() },
      hard_expires_at: { S: route.hardExpiresAt },
      platform_expires_at: { S: route.platformExpiresAt },
      last_access_at: { S: now.toISOString() },
      version: { N: "1" }
    },
    ConditionExpression: "attribute_not_exists(tenant_id)"
  }));
  return route;
}

async function replaceRouteWithLease(route, requestId) {
  const generation = route.generation + 1;
  const now = new Date();
  const leaseExpiresAt = Math.floor(now.getTime() / 1000) + leaseSeconds;
  const drainingAssignment = route.microvmId ? ", draining_microvm_id = :draining" : "";
  const expressionAttributeValues = {
    ":generation": { N: String(generation) },
    ":provisioning": { S: "PROVISIONING" },
    ":image": { S: imageVersion },
    ":owner": { S: requestId },
    ":lease": { N: String(leaseExpiresAt) },
    ":now": { S: now.toISOString() },
    ":hard": {
      S: new Date(now.getTime() + (maximumDurationSeconds - hardExpiryMarginSeconds) * 1000).toISOString()
    },
    ":platform": { S: new Date(now.getTime() + maximumDurationSeconds * 1000).toISOString() },
    ":version": { N: String(route.version) },
    ":one": { N: "1" }
  };
  if (route.microvmId) expressionAttributeValues[":draining"] = { S: route.microvmId };

  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenant_id: { S: route.tenantId } },
    UpdateExpression:
      "SET generation = :generation, #state = :provisioning, image_version = :image, " +
      "lease_owner = :owner, lease_expires_at = :lease, created_at = :now, last_access_at = :now, " +
      `hard_expires_at = :hard, platform_expires_at = :platform${drainingAssignment} ` +
      "REMOVE microvm_id, endpoint ADD version :one",
    ConditionExpression: "version = :version",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: expressionAttributeValues
  }));
  return {
    tenantId: route.tenantId,
    generation,
    state: "PROVISIONING",
    imageVersion,
    leaseOwner: requestId,
    leaseExpiresAt,
    drainingMicrovmId: route.microvmId,
    version: route.version + 1
  };
}

async function takeOverExpiredLease(route, requestId) {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiresAt = now + leaseSeconds;
  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenant_id: { S: route.tenantId } },
    UpdateExpression: "SET lease_owner = :owner, lease_expires_at = :lease ADD version :one",
    ConditionExpression: "#state = :provisioning AND generation = :generation AND lease_expires_at < :now",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":owner": { S: requestId },
      ":lease": { N: String(leaseExpiresAt) },
      ":provisioning": { S: "PROVISIONING" },
      ":generation": { N: String(route.generation) },
      ":now": { N: String(now) },
      ":one": { N: "1" }
    }
  }));
  return { ...route, leaseOwner: requestId, leaseExpiresAt, version: route.version + 1 };
}

async function recordLaunchedMicrovm(route, launched) {
  const startedAt = launched.startedAt instanceof Date ? launched.startedAt : new Date();
  const hardExpiresAt =
    new Date(startedAt.getTime() + (maximumDurationSeconds - hardExpiryMarginSeconds) * 1000).toISOString();
  const platformExpiresAt = new Date(startedAt.getTime() + maximumDurationSeconds * 1000).toISOString();
  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenant_id: { S: route.tenantId } },
    UpdateExpression:
      "SET microvm_id = :microvm, endpoint = :endpoint, hard_expires_at = :hard, " +
      "platform_expires_at = :platform ADD version :one",
    ConditionExpression: "generation = :generation AND lease_owner = :owner",
    ExpressionAttributeValues: {
      ":microvm": { S: launched.microvmId },
      ":endpoint": { S: launched.endpoint },
      ":hard": { S: hardExpiresAt },
      ":platform": { S: platformExpiresAt },
      ":generation": { N: String(route.generation) },
      ":owner": { S: route.leaseOwner },
      ":one": { N: "1" }
    }
  }));
}

async function markRunning(tenantId, generation, microvmId) {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: tenantId } },
      UpdateExpression: "SET #state = :running REMOVE lease_owner, lease_expires_at",
      ConditionExpression: "generation = :generation AND microvm_id = :microvm",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":running": { S: "RUNNING" },
        ":generation": { N: String(generation) },
        ":microvm": { S: microvmId }
      }
    }));
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
  }
}

async function waitForRunning(route) {
  const deadline = Date.now() + provisioningWaitMilliseconds;
  let delay = 200;
  while (Date.now() < deadline) {
    const current = await getRoute(route.tenantId);
    if (!current || current.generation !== route.generation) return current;
    if (current.state === "RUNNING" || current.state === "SUSPENDED") return current;
    if (current.microvmId) {
      const remote = await microvms.send(new GetMicrovmCommand({
        microvmIdentifier: current.microvmId
      }));
      if (remote.state === "RUNNING") {
        await markRunning(current.tenantId, current.generation, current.microvmId);
        return getRoute(current.tenantId);
      }
      if (remote.state === "TERMINATED" || remote.state === "TERMINATING") return current;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.floor(delay * 1.7), 1000);
  }
  return getRoute(route.tenantId);
}

async function launchForLease(route, tenantLogHash) {
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
    runHookPayload: JSON.stringify({ generation: route.generation }),
    clientToken: clientToken(route.tenantId, route.generation)
  }));
  await recordLaunchedMicrovm(route, launched);
  console.info(JSON.stringify({
    timestamp: nowIso(),
    level: "INFO",
    service: "routing-proxy",
    event: "microvm.launched",
    tenant_hash: tenantLogHash,
    microvm_id: launched.microvmId,
    generation: route.generation,
    lifecycle_state: launched.state,
    outcome: "success"
  }));
  return waitForRunning({ ...route, microvmId: launched.microvmId, endpoint: launched.endpoint });
}

async function terminateDrainingMicrovm(route, tenantLogHash) {
  if (!route?.drainingMicrovmId || !["RUNNING", "SUSPENDED"].includes(route.state)) return;
  try {
    await microvms.send(new TerminateMicrovmCommand({
      microvmIdentifier: route.drainingMicrovmId
    }));
    await dynamodb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: route.tenantId } },
      UpdateExpression: "REMOVE draining_microvm_id",
      ConditionExpression: "generation = :generation AND draining_microvm_id = :draining",
      ExpressionAttributeValues: {
        ":generation": { N: String(route.generation) },
        ":draining": { S: route.drainingMicrovmId }
      }
    }));
  } catch (error) {
    if (!conditionalFailure(error)) {
      console.warn(JSON.stringify({
        event: "microvm.terminate_failed",
        tenant_hash: tenantLogHash,
        microvm_id: route.drainingMicrovmId,
        error_code: serviceErrorName(error)
      }));
    }
  }
}

async function ensureRunnableRoute(tenantId, requestId, tenantLogHash) {
  let route = await getRoute(tenantId);
  let ownsLease = false;
  const nowSeconds = Math.floor(Date.now() / 1000);

  try {
    if (!route) {
      route = await createInitialLease(tenantId, requestId);
      ownsLease = true;
    } else if (route.state === "PROVISIONING") {
      if (route.leaseExpiresAt < nowSeconds) {
        route = await takeOverExpiredLease(route, requestId);
        ownsLease = true;
      }
    } else if (
      route.state === "FAILED" ||
      route.state === "DRAINING" ||
      (route.hardExpiresAt && Date.parse(route.hardExpiresAt) <= Date.now())
    ) {
      route = await replaceRouteWithLease(route, requestId);
      ownsLease = true;
    }
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    route = await getRoute(tenantId);
  }

  if (ownsLease) route = await launchForLease(route, tenantLogHash);
  else if (route?.state === "PROVISIONING") route = await waitForRunning(route);
  await terminateDrainingMicrovm(route, tenantLogHash);
  return route;
}

async function tokenFor(microvmId, forceRefresh = false) {
  const cached = tokenCache.get(microvmId);
  if (!forceRefresh && cached?.expiresAt > Date.now()) return cached.value;

  const result = await microvms.send(new CreateMicrovmAuthTokenCommand({
    microvmIdentifier: microvmId,
    expirationInMinutes: tokenTtlMinutes,
    allowedPorts: [{ port: 8080 }]
  }));
  const value = result.authToken?.["X-aws-proxy-auth"];
  if (!value) throw new Error("MicroVM auth token response did not contain X-aws-proxy-auth");
  tokenCache.set(microvmId, {
    value,
    expiresAt: Date.now() + Math.max(tokenTtlMinutes * 60 - 30, 1) * 1000
  });
  return value;
}

function upstreamUrl(route, event) {
  const endpoint = /^https?:\/\//.test(route.endpoint) ? route.endpoint : `https://${route.endpoint}`;
  const url = new URL(event.path || "/", endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  for (const [key, values] of Object.entries(event.multiValueQueryStringParameters || {})) {
    for (const value of values || []) url.searchParams.append(key, value);
  }
  if (!event.multiValueQueryStringParameters) {
    for (const [key, value] of Object.entries(event.queryStringParameters || {})) {
      if (value !== undefined && value !== null) url.searchParams.append(key, value);
    }
  }
  return url;
}

function upstreamHeaders(event, requestId, token) {
  const headers = {
    "x-aws-proxy-auth": token,
    "x-aws-proxy-port": "8080",
    "x-request-id": requestId
  };
  for (const [name, value] of Object.entries(event.headers || {})) {
    const lower = name.toLowerCase();
    if (forwardedRequestHeaders.has(lower) && typeof value === "string") headers[lower] = value;
  }
  return headers;
}

function upstreamBody(event, method) {
  if (method === "GET" || method === "HEAD" || event.body === undefined || event.body === null) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
}

function clientResponseFromUpstream(upstream, body, requestId) {
  const headers = { "x-request-id": requestId };
  for (const [name, value] of upstream.headers.entries()) {
    if (forwardedResponseHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  const setCookies = typeof upstream.headers.getSetCookie === "function"
    ? upstream.headers.getSetCookie()
    : [];
  const result = {
    statusCode: upstream.status,
    headers,
    body: body.toString("base64"),
    isBase64Encoded: true
  };
  if (setCookies.length > 0) result.multiValueHeaders = { "set-cookie": setCookies };
  return result;
}

async function forward(event, route, requestId, tenantLogHash, deadlineMilliseconds) {
  const method = String(event.httpMethod || "GET").toUpperCase();
  const retries = idempotentMethods.has(method) ? 1 : 0;
  let forceRefresh = false;
  let networkRetries = retries;
  let authRetries = 1;

  while (true) {
    if (deadlineMilliseconds <= Date.now()) {
      const error = new Error("Proxy request deadline exceeded");
      error.name = "ProxyDeadlineExceeded";
      throw error;
    }
    const token = await tokenFor(route.microvmId, forceRefresh);
    const remainingMilliseconds = deadlineMilliseconds - Date.now();
    if (remainingMilliseconds <= 0) {
      const error = new Error("Proxy request deadline exceeded");
      error.name = "ProxyDeadlineExceeded";
      throw error;
    }
    forceRefresh = false;
    try {
      const upstream = await fetch(upstreamUrl(route, event), {
        method,
        headers: upstreamHeaders(event, requestId, token),
        body: upstreamBody(event, method),
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(25_000, remainingMilliseconds))
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if ((upstream.status === 401 || upstream.status === 403) && authRetries > 0) {
        authRetries -= 1;
        forceRefresh = true;
        tokenCache.delete(route.microvmId);
        continue;
      }
      if (upstream.status >= 500 && networkRetries > 0) {
        networkRetries -= 1;
        continue;
      }
      if (upstream.status === 401 || upstream.status === 403) {
        console.error(JSON.stringify({
          event: "proxy.upstream_auth_failed",
          request_id: requestId,
          tenant_hash: tenantLogHash,
          microvm_id: route.microvmId,
          generation: route.generation
        }));
        return response(502, requestId, { error: "upstream_auth_failed" });
      }
      return clientResponseFromUpstream(upstream, body, requestId);
    } catch (error) {
      if (networkRetries > 0) {
        networkRetries -= 1;
        continue;
      }
      throw error;
    }
  }
}

async function recordAccess(route) {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: route.tenantId } },
      UpdateExpression: "SET last_access_at = :now",
      ConditionExpression: "attribute_exists(tenant_id) AND microvm_id = :microvm",
      ExpressionAttributeValues: {
        ":now": { S: nowIso() },
        ":microvm": { S: route.microvmId }
      }
    }));
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
  }
}

exports.handler = async function handler(event, context) {
  const requestId = requestIdFor(event, context);
  const proxyDeadlineMilliseconds =
    Date.now() + Math.max(context.getRemainingTimeInMillis() - 1_000, 1);
  if (String(event.path || "").startsWith("/aws/lambda-microvms/runtime/")) {
    return response(404, requestId, { error: "not_found" });
  }

  const claims = event.requestContext?.authorizer?.claims;
  const tenantId = claims?.["custom:tenant_id"] || claims?.sub;
  if (!tenantId) return response(403, requestId, { error: "tenant_claim_missing" });
  const tenantLogHash = tenantHash(tenantId);

  try {
    const route = await ensureRunnableRoute(tenantId, requestId, tenantLogHash);
    if (!route || !["RUNNING", "SUSPENDED"].includes(route.state) || !route.microvmId || !route.endpoint) {
      console.info(JSON.stringify({
        event: "route.provisioning",
        request_id: requestId,
        tenant_hash: tenantLogHash,
        generation: route?.generation,
        lifecycle_state: route?.state
      }));
      return response(202, requestId, {
        status: "provisioning",
        generation: route?.generation
      }, { "retry-after": "2" });
    }

    const result = await forward(
      event,
      route,
      requestId,
      tenantLogHash,
      proxyDeadlineMilliseconds
    );
    await recordAccess(route);
    console.info(JSON.stringify({
      timestamp: nowIso(),
      level: "INFO",
      service: "routing-proxy",
      event: "proxy.complete",
      request_id: requestId,
      tenant_hash: tenantLogHash,
      microvm_id: route.microvmId,
      generation: route.generation,
      lifecycle_state: route.state,
      outcome: "success"
    }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: nowIso(),
      level: "ERROR",
      service: "routing-proxy",
      event: "proxy.error",
      request_id: requestId,
      tenant_hash: tenantLogHash,
      outcome: "failure",
      error_code: serviceErrorName(error)
    }));
    return response(503, requestId, { error: "control_plane_unavailable", retryable: true });
  }
};

exports._private = {
  clientToken,
  requestIdFor,
  routeFromItem,
  clientResponseFromUpstream,
  upstreamBody,
  upstreamHeaders,
  upstreamUrl
};
