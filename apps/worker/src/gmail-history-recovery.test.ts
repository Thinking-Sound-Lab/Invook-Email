import assert from "node:assert/strict";
import { test } from "node:test";

import { GmailApiError } from "@invook/gmail";

import { applyGmailHistoryWithExpiredCursorRepair } from "./gmail-history-recovery";

test("an expired Gmail history cursor enters the full repair path", async () => {
  let repairCalls = 0;
  const result = await applyGmailHistoryWithExpiredCursorRepair({
    apply: async () => {
      throw new GmailApiError("History cursor expired", 404, "not found");
    },
    repair: async () => {
      repairCalls += 1;
      return { historyCursor: "fresh-cursor", auditId: "audit-id" };
    },
  });

  assert.equal(result.outcome, "repaired");
  assert.equal(repairCalls, 1);
  assert.deepEqual(result.result, {
    historyCursor: "fresh-cursor",
    auditId: "audit-id",
  });
});

test("non-expiration Gmail failures do not trigger mailbox repair", async () => {
  let repairCalls = 0;
  await assert.rejects(
    applyGmailHistoryWithExpiredCursorRepair({
      apply: async () => {
        throw new GmailApiError("Gmail unavailable", 503, "unavailable");
      },
      repair: async () => {
        repairCalls += 1;
        return { historyCursor: "unexpected" };
      },
    }),
    /Gmail unavailable/,
  );
  assert.equal(repairCalls, 0);
});
