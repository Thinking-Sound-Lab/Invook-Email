import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBearerChallenge,
  readBearerToken,
  readMcpIdentity,
  toMcpAuthInfo,
} from "./mcp-access";

test("only a well-formed bearer header yields a token", () => {
  assert.equal(readBearerToken(`Bearer ${"a".repeat(32)}`), "a".repeat(32));
  assert.equal(readBearerToken(`bearer ${"a".repeat(32)}`), "a".repeat(32));
  assert.equal(readBearerToken(undefined), null);
  assert.equal(readBearerToken(["Bearer one", "Bearer two"]), null);
  assert.equal(readBearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(readBearerToken("Bearer "), null);
  assert.equal(readBearerToken("Bearer two tokens"), null);
  assert.equal(readBearerToken(`Bearer ${"a".repeat(513)}`), null);
});

test("challenges name the metadata document and the scopes to request", () => {
  const resourceMetadataUrl = "https://invook.example/.well-known/oauth-protected-resource/mcp";

  assert.equal(
    buildBearerChallenge({ resourceMetadataUrl }),
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="mail offline_access"`,
  );
  assert.equal(
    buildBearerChallenge({ resourceMetadataUrl, error: "invalid_token" }),
    `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}", scope="mail offline_access"`,
  );
});

test("the verified identity survives the SDK's auth info round trip", () => {
  const identity = {
    userId: "11111111-1111-4111-8111-111111111111",
    clientId: "agentClientId",
  };
  const authInfo = toMcpAuthInfo({ token: "token", identity, scopes: ["mail"] });

  assert.deepEqual(readMcpIdentity(authInfo), identity);
  assert.equal(readMcpIdentity(undefined), null);
  assert.equal(
    readMcpIdentity({ token: "token", clientId: "agentClientId", scopes: [] }),
    null,
  );
});
