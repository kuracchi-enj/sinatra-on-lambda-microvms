"use strict";

const { _private } = require("../runtime/proxy/index");

test("request ids are accepted only when safe for logs and headers", () => {
  expect(_private.requestIdFor(
    { headers: { "x-request-id": "request-123" } },
    { awsRequestId: "fallback" }
  )).toBe("request-123");
  expect(_private.requestIdFor(
    { headers: { "x-request-id": "unsafe request id" } },
    { awsRequestId: "fallback" }
  )).toBe("fallback");
});

test("client token is deterministic per tenant generation without exposing tenant id", () => {
  const first = _private.clientToken("tenant-secret", 7);
  expect(first).toBe(_private.clientToken("tenant-secret", 7));
  expect(first).not.toContain("tenant-secret");
  expect(first).not.toBe(_private.clientToken("tenant-secret", 8));
});

test("route parser maps DynamoDB values", () => {
  expect(_private.routeFromItem({
    tenant_id: { S: "tenant-a" },
    generation: { N: "3" },
    microvm_id: { S: "mvm-3" },
    endpoint: { S: "example.lambda-microvm.amazonaws.com" },
    state: { S: "RUNNING" },
    version: { N: "5" }
  })).toEqual(expect.objectContaining({
    tenantId: "tenant-a",
    generation: 3,
    microvmId: "mvm-3",
    state: "RUNNING",
    version: 5
  }));
});

test("upstream URL preserves path and repeated query parameters", () => {
  const url = _private.upstreamUrl(
    { endpoint: "mvm.example" },
    {
      path: "/items",
      multiValueQueryStringParameters: { tag: ["one", "two"] }
    }
  );
  expect(url.toString()).toBe("https://mvm.example/items?tag=one&tag=two");
});

test("upstream headers never forward public authorization or reserved proxy headers", () => {
  const headers = _private.upstreamHeaders({
    headers: {
      Authorization: "Bearer public-token",
      "X-aws-proxy-auth": "attacker-token",
      Accept: "application/json",
      Cookie: "session=abc"
    }
  }, "request-1", "server-side-jwe");

  expect(headers.authorization).toBeUndefined();
  expect(headers["x-aws-proxy-auth"]).toBe("server-side-jwe");
  expect(headers.accept).toBe("application/json");
  expect(headers.cookie).toBe("session=abc");
});

test("base64 API Gateway body is decoded for the upstream request", () => {
  const body = _private.upstreamBody({
    body: Buffer.from("hello").toString("base64"),
    isBase64Encoded: true
  }, "POST");
  expect(body.toString()).toBe("hello");
});

test("upstream responses preserve binary bytes and repeated cookies", () => {
  const headers = new globalThis.Headers({ "content-type": "application/octet-stream" });
  headers.getSetCookie = () => ["one=1; Path=/", "two=2; Path=/"];
  const response = _private.clientResponseFromUpstream(
    { status: 200, headers },
    Buffer.from([0, 255, 1]),
    "request-1"
  );

  expect(response.isBase64Encoded).toBe(true);
  expect(Buffer.from(response.body, "base64")).toEqual(Buffer.from([0, 255, 1]));
  expect(response.multiValueHeaders["set-cookie"]).toHaveLength(2);
});
