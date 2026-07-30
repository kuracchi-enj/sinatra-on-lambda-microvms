"use strict";

const { _private } = require("../runtime/reconciler/index");

test("rotation client token is deterministic per tenant generation", () => {
  const token = _private.clientToken("tenant-secret", 4);
  expect(token).toBe(_private.clientToken("tenant-secret", 4));
  expect(token).not.toContain("tenant-secret");
  expect(token).not.toBe(_private.clientToken("tenant-secret", 5));
});

test("rotation starts only when the hard expiry timestamp has arrived", () => {
  const item = { hard_expires_at: { S: "2026-07-30T12:00:00.000Z" } };
  expect(_private.shouldRotate(item, Date.parse("2026-07-30T11:59:59.999Z"))).toBe(false);
  expect(_private.shouldRotate(item, Date.parse("2026-07-30T12:00:00.000Z"))).toBe(true);
  expect(_private.shouldRotate({}, Date.now())).toBe(false);
});
