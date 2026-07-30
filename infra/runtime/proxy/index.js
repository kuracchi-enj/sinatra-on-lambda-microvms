"use strict";

const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const crypto = require("node:crypto");

const client = new DynamoDBClient({});
const tableName = process.env.ROUTES_TABLE_NAME;

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

exports.handler = async function handler(event, context) {
  const requestId = event.headers?.["X-Request-Id"] || event.headers?.["x-request-id"] || context.awsRequestId;
  const claims = event.requestContext?.authorizer?.claims;
  const tenantId = claims?.["custom:tenant_id"] || claims?.sub;
  if (!tenantId) return response(403, requestId, { error: "tenant_claim_missing" });

  const tenantHash = crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
  try {
    const result = await client.send(new GetItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: tenantId } },
      ConsistentRead: true
    }));
    const route = result.Item;
    if (!route) {
      console.info(JSON.stringify({ event: "route.missing", request_id: requestId, tenant_hash: tenantHash }));
      return response(503, requestId, { error: "route_unavailable", retryable: true }, { "retry-after": "5" });
    }

    await client.send(new UpdateItemCommand({
      TableName: tableName,
      Key: { tenant_id: { S: tenantId } },
      UpdateExpression: "SET last_access_at = :now",
      ExpressionAttributeValues: { ":now": { S: new Date().toISOString() } }
    }));
    console.info(JSON.stringify({
      event: "route.observed",
      request_id: requestId,
      tenant_hash: tenantHash,
      microvm_id: route.microvm_id?.S,
      generation: Number(route.generation?.N || 0),
      lifecycle_state: route.state?.S
    }));

    // The official control API and JWE token schema are a Gate 0 prerequisite.
    // Do not leak the stored endpoint or invent an SDK operation while that gate is open.
    return response(503, requestId, {
      error: "microvm_control_api_unavailable",
      retryable: false,
      generation: Number(route.generation?.N || 0)
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "proxy.error", request_id: requestId, tenant_hash: tenantHash, error_code: error.name }));
    return response(503, requestId, { error: "control_plane_unavailable", retryable: true });
  }
};
