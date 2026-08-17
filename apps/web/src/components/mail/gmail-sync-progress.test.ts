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

test("message discovery shows processed progress against the messages found so far", () => {
  assert.deepEqual(
    getGmailSyncProgressPresentation({
      state: "running",
      discoveryComplete: false,
      discoveredMessageCount: 3_400,
      processedMessageCount: 1_200,
      failedMessageCount: 0,
    }),
    {
      title: "Finding and syncing Gmail",
      detail: "1,200 of 3,400 discovered messages synced",
      percentage: 35,
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
