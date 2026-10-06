import assert from "node:assert/strict";
import { test } from "node:test";

import { getApiUrl } from "./api-url";

test("API routing preserves the gateway stage and request query", () => {
  assert.equal(
    getApiUrl("/v1/mailbox/events?account=account-id", "https://example.com/prod/").toString(),
    "https://example.com/prod/v1/mailbox/events?account=account-id",
  );
  assert.equal(
    getApiUrl("/v1/session", "http://api:4000").toString(),
    "http://api:4000/v1/session",
  );
});

test("API routing rejects ambiguous base URLs and external request paths", () => {
  for (const base of ["file:///tmp", "https://example.com?stage=prod", "https://example.com/#fragment"]) {
    assert.throws(() => getApiUrl("/v1/session", base));
  }
  assert.throws(() => getApiUrl("//example.com/v1/session"));
});
