import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeAgentRedirectTarget,
  formatAgentRedirectTarget,
} from "./agent-redirect-target";

test("hosted agents are identified by the host they return to", () => {
  const target = describeAgentRedirectTarget("https://claude.ai/api/mcp/auth_callback");

  assert.deepEqual(target, { kind: "website", host: "claude.ai" });
  assert.equal(target && formatAgentRedirectTarget(target), "claude.ai");
});

test("local command-line agents are described as apps on this computer", () => {
  for (const uri of [
    "http://localhost:51234/callback",
    "http://127.0.0.1:33418/callback",
    "http://[::1]:8080/callback",
    "http://127.0.0.2:4000/callback",
    "http://agent.localhost:4000/callback",
  ]) {
    assert.deepEqual(describeAgentRedirectTarget(uri), { kind: "this-computer" }, uri);
  }
});

test("desktop agents with their own URL scheme are named by that scheme", () => {
  const target = describeAgentRedirectTarget(
    "cursor://anysphere.cursor-mcp/oauth/callback",
  );

  assert.deepEqual(target, { kind: "app", scheme: "cursor" });
  assert.equal(target && formatAgentRedirectTarget(target), "the cursor app on this device");
});

test("an unreadable or insecure target is not described as trustworthy", () => {
  assert.equal(describeAgentRedirectTarget("not a url"), null);
  assert.equal(describeAgentRedirectTarget("http://agent.example/callback"), null);
});
