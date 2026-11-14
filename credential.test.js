// Shark answers 'Unable to find user details' for rejected API keys; disconnect must not get stuck on it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isCredentialError, disconnectOnFlattenError } = require("./shark");

test("isCredentialError recognises Shark rejecting the user or credentials", () => {
  assert.equal(isCredentialError("Unable to find user details"), true);
  assert.equal(isCredentialError("Invalid API key"), true);
  assert.equal(isCredentialError("invalid api-key"), true);
  assert.equal(isCredentialError("Invalid apikey"), true);
  assert.equal(isCredentialError("API key not found"), true);
  assert.equal(isCredentialError("Invalid signature"), true);
  assert.equal(isCredentialError("Unauthorised"), true);
  assert.equal(isCredentialError("Forbidden"), true);
  assert.equal(isCredentialError("BTCUSDT: Unauthorized"), true);
  assert.equal(isCredentialError("anything", 401), true);
  assert.equal(isCredentialError("anything", 403), true);
  assert.equal(isCredentialError(undefined, 403), true);
});

test("isCredentialError ignores network errors, order rejections and generic failures", () => {
  assert.equal(isCredentialError(null), false);
  assert.equal(isCredentialError(undefined), false);
  assert.equal(isCredentialError(""), false);
  assert.equal(isCredentialError("socket hang up"), false);
  assert.equal(isCredentialError("ECONNRESET"), false);
  assert.equal(isCredentialError("ETIMEDOUT"), false);
  assert.equal(isCredentialError("Order quantity is out of range"), false);
  assert.equal(isCredentialError("Insufficient margin"), false);
  assert.equal(isCredentialError("Shark returned 500", 500), false);
  assert.equal(isCredentialError("Could not load positions"), false);
});

test("disconnect deletes the account only when Shark rejects the credentials", () => {
  assert.equal(disconnectOnFlattenError(new Error("Unable to find user details")), true);
  const unauthorized = new Error("Shark returned 401");
  unauthorized.status = 401;
  assert.equal(disconnectOnFlattenError(unauthorized), true);
  assert.equal(disconnectOnFlattenError(new Error("ECONNRESET")), false);
  assert.equal(disconnectOnFlattenError(new Error("Order quantity is out of range")), false);
  assert.equal(disconnectOnFlattenError(undefined), false);
});
