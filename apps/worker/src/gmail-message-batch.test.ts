import assert from "node:assert/strict";
import test from "node:test";

import { GMAIL_SYNC_MESSAGE_BATCH_SIZE } from "@invook/database";

import {
  parseGmailMessageBatchPayload,
  processGmailMessageBatch,
} from "./gmail-message-batch";

test("Gmail message batch payloads are bounded and unique", () => {
  const providerMessageIds = Array.from(
    { length: GMAIL_SYNC_MESSAGE_BATCH_SIZE },
    (_, index) => `message-${index + 1}`,
  );
  assert.deepEqual(
    parseGmailMessageBatchPayload({ runId: "run-1", providerMessageIds }),
    { runId: "run-1", providerMessageIds },
  );
  assert.throws(
    () =>
      parseGmailMessageBatchPayload({
        runId: "run-1",
        providerMessageIds: [...providerMessageIds, "message-overflow"],
      }),
    /IDs are invalid/i,
  );
  assert.throws(
    () =>
      parseGmailMessageBatchPayload({
        runId: "run-1",
        providerMessageIds: ["message-1", "message-1"],
      }),
    /IDs are invalid/i,
  );
});

test("a Gmail message batch bounds concurrency and finishes independent items", async () => {
  const providerMessageIds = Array.from(
    { length: 11 },
    (_, index) => `message-${index + 1}`,
  );
  let activeCount = 0;
  let maximumActiveCount = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const startedMessageIds: string[] = [];
  const processing = processGmailMessageBatch({
    providerMessageIds,
    concurrency: 5,
    processMessage: async (providerMessageId) => {
      activeCount += 1;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      startedMessageIds.push(providerMessageId);
      if (startedMessageIds.length === 5) release?.();
      await gate;
      activeCount -= 1;
      if (providerMessageId === "message-7") {
        throw new Error("retryable");
      }
    },
  });
  await gate;
  const result = await processing;

  assert.equal(maximumActiveCount, 5);
  assert.deepEqual(result.succeededMessageIds, [
    "message-1",
    "message-2",
    "message-3",
    "message-4",
    "message-5",
    "message-6",
    "message-8",
    "message-9",
    "message-10",
    "message-11",
  ]);
  assert.deepEqual(
    result.failures.map((failure) => failure.providerMessageId),
    ["message-7"],
  );
});
