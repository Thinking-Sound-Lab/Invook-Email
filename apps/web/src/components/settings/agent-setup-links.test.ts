import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCursorInstallLink } from "./agent-setup-links";

test("the Cursor install link carries Invook's remote server entry", () => {
  const link = new URL(buildCursorInstallLink("https://invook.example/mcp"));

  assert.equal(link.protocol, "cursor:");
  assert.equal(link.host, "anysphere.cursor-deeplink");
  assert.equal(link.pathname, "/mcp/install");
  assert.equal(link.searchParams.get("name"), "invook");
  assert.deepEqual(JSON.parse(atob(link.searchParams.get("config") ?? "")), {
    url: "https://invook.example/mcp",
  });
});
