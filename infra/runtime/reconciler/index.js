"use strict";

const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const client = new DynamoDBClient({});
const tableName = process.env.ROUTES_TABLE_NAME;
const leaseGraceSeconds = Number(process.env.PROVISIONING_LEASE_GRACE_SECONDS || 60);

exports.handler = async function handler(event, context) {
  const now = Math.floor(Date.now() / 1000);
  let lastEvaluatedKey;
  let failed = 0;
  do {
    const page = await client.send(new ScanCommand({
      TableName: tableName,
      ProjectionExpression: "tenant_id, #state, lease_expires_at, version",
      ExpressionAttributeNames: { "#state": "state" },
      ExclusiveStartKey: lastEvaluatedKey
    }));
    for (const item of page.Items || []) {
      if (item.state?.S !== "PROVISIONING" || Number(item.lease_expires_at?.N || now + 1) + leaseGraceSeconds >= now) continue;
      try {
        await client.send(new UpdateItemCommand({
          TableName: tableName,
          Key: { tenant_id: item.tenant_id },
          UpdateExpression: "SET #state = :failed, version = :next REMOVE lease_owner, lease_expires_at",
          ConditionExpression: "#state = :provisioning AND version = :current",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":failed": { S: "FAILED" },
            ":provisioning": { S: "PROVISIONING" },
            ":current": item.version || { N: "0" },
            ":next": { N: String(Number(item.version?.N || 0) + 1) }
          }
        }));
        failed += 1;
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
      }
    }
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.info(JSON.stringify({ event: "reconcile.complete", request_id: context.awsRequestId, failed_routes: failed }));
  return { failed_routes: failed };
};
