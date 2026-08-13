import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMailSyncProgress,
  hasMailSyncPercentageAdvanced,
} from "./mail-sync-progress";

test("mail sync progress preserves durable run counts", () => {
  assert.deepEqual(
    deriveMailSyncProgress({
      state: "running",
      run: {
        discoveryComplete: true,
        discoveredMessageCount: 71_468,
        processedMessageCount: 14_895,
        failedMessageCount: 0,
      },
    }),
    {
      state: "running",
      discoveryComplete: true,
      discoveredMessageCount: 71_468,
      processedMessageCount: 14_895,
      failedMessageCount: 0,
    },
  );
});

test("a completed account is known to have finished discovery without a run", () => {
  assert.deepEqual(deriveMailSyncProgress({ state: "complete", run: null }), {
    state: "complete",
    discoveryComplete: true,
    discoveredMessageCount: 0,
    processedMessageCount: 0,
    failedMessageCount: 0,
  });
});

test("sync notifications advance only on a new whole percentage", () => {
  assert.equal(
    hasMailSyncPercentageAdvanced({
      discoveryComplete: true,
      discoveredMessageCount: 10_000,
      previousProcessedMessageCount: 99,
      processedMessageCount: 100,
    }),
    true,
  );
  assert.equal(
    hasMailSyncPercentageAdvanced({
      discoveryComplete: true,
      discoveredMessageCount: 10_000,
      previousProcessedMessageCount: 100,
      processedMessageCount: 101,
    }),
    false,
  );
  assert.equal(
    hasMailSyncPercentageAdvanced({
      discoveryComplete: false,
      discoveredMessageCount: 10_000,
      previousProcessedMessageCount: 99,
      processedMessageCount: 100,
    }),
    false,
  );
});
