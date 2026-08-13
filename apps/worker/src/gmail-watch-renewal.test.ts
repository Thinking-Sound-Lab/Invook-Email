import assert from "node:assert/strict";
import { test } from "node:test";

import { runDailyGmailWatchRenewal } from "./gmail-watch-renewal";

test("daily watch renewal catches up before scheduling exactly one successor", async () => {
  const calls: string[] = [];
  const result = await runDailyGmailWatchRenewal({
    renew: async () => {
      calls.push("renew");
      return {
        renewedAt: new Date("2026-08-13T10:00:00.000Z"),
        expirationAt: new Date("2026-08-20T10:00:00.000Z"),
      };
    },
    catchUp: async () => {
      calls.push("catch-up");
      return { status: "complete", historyCursor: "123" };
    },
    scheduleNext: async () => {
      calls.push("schedule-next");
      return "next-renewal-step";
    },
  });

  assert.deepEqual(calls, ["renew", "catch-up", "schedule-next"]);
  assert.equal(result.nextRenewalStepId, "next-renewal-step");
  assert.equal(result.catchup.status, "complete");
});

test("failed catch-up does not schedule another daily renewal", async () => {
  let scheduleCalls = 0;
  await assert.rejects(
    runDailyGmailWatchRenewal({
      renew: async () => ({
        renewedAt: new Date("2026-08-13T10:00:00.000Z"),
        expirationAt: new Date("2026-08-20T10:00:00.000Z"),
      }),
      catchUp: async () => {
        throw new Error("catch-up failed");
      },
      scheduleNext: async () => {
        scheduleCalls += 1;
        return "unexpected";
      },
    }),
    /catch-up failed/,
  );
  assert.equal(scheduleCalls, 0);
});
