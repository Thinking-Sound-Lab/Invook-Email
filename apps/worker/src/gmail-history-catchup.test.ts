import assert from "node:assert/strict";
import test from "node:test";

import { gmailHistoryCatchupDisposition } from "./gmail-history-catchup";

test("a pending cursor yields to a durable continuation after one range", () => {
  assert.equal(
    gmailHistoryCatchupDisposition({
      applied: true,
      pendingHistoryCursor: "150",
    }),
    "continue_durably",
  );
});

test("a caught-up range completes and a stale range is superseded", () => {
  assert.equal(
    gmailHistoryCatchupDisposition({
      applied: true,
      pendingHistoryCursor: null,
    }),
    "complete",
  );
  assert.equal(
    gmailHistoryCatchupDisposition({
      applied: false,
      pendingHistoryCursor: "150",
    }),
    "superseded",
  );
});
