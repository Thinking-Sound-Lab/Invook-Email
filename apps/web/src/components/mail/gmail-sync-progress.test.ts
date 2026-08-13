import assert from "node:assert/strict";
import test from "node:test";

import { getGmailSyncProgressPresentation } from "./gmail-sync-progress";

test("active Gmail synchronization shows durable counts and percentage", () => {
  assert.deepEqual(
    getGmailSyncProgressPresentation({
      state: "running",
      discoveryComplete: true,
      discoveredMessageCount: 71_468,
      processedMessageCount: 14_895,
      failedMessageCount: 0,
    }),
    {
      title: "Syncing Gmail",
      detail: "14,895 of 71,468 messages synced",
      percentage: 21,
      isFailed: false,
    },
  );
});

test("message discovery stays honest while Gmail has not reported a total", () => {
  assert.deepEqual(
    getGmailSyncProgressPresentation({
      state: "running",
      discoveryComplete: false,
      discoveredMessageCount: 3_400,
      processedMessageCount: 1_200,
      failedMessageCount: 0,
    }),
    {
      title: "Finding Gmail messages",
      detail: "3,400 messages found so far",
      percentage: null,
      isFailed: false,
    },
  );
});

test("completed Gmail synchronization removes the progress presentation", () => {
  assert.equal(
    getGmailSyncProgressPresentation({
      state: "complete",
      discoveryComplete: true,
      discoveredMessageCount: 71_468,
      processedMessageCount: 71_468,
      failedMessageCount: 0,
    }),
    null,
  );
});
