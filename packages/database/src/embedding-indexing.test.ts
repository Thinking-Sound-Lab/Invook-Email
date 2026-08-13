import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBatchEventIdempotencyKey,
  decideEmbeddingContinuation,
  deriveIndexingProgress,
  type IndexingPrerequisiteState,
} from "./embedding-indexing";

const readyPrerequisites = {
  accountStatus: "connected",
  mailSyncStage: "complete",
  replicaState: "ready",
} satisfies IndexingPrerequisiteState;

test("a completed 2,000-item batch durably continues when current messages remain", () => {
  assert.deepEqual(
    decideEmbeddingContinuation({
      prerequisites: readyPrerequisites,
      incompleteMessageCount: 573,
      failedMessageCount: 0,
      currentFailedMessageIds: [],
      batchAttempt: 1,
      batchAttemptLimit: 3,
    }),
    {
      stage: "running",
      continuation: {
        reason: "next",
        includeFailed: false,
        batchAttempt: 1,
      },
    },
  );
});

test("duplicate webhook delivery uses one durable correlation key", () => {
  const first = createBatchEventIdempotencyKey({
    provider: "openai",
    webhookId: "webhook-123",
  });
  const duplicate = createBatchEventIdempotencyKey({
    provider: "openai",
    webhookId: "webhook-123",
  });
  const distinct = createBatchEventIdempotencyKey({
    provider: "openai",
    webhookId: "webhook-456",
  });

  assert.equal(duplicate, first);
  assert.notEqual(distinct, first);
});

test("provider request failures retry with a bounded batch attempt", () => {
  const failedMessageIds = ["failed-message-1", "failed-message-2"];
  assert.deepEqual(
    decideEmbeddingContinuation({
      prerequisites: readyPrerequisites,
      incompleteMessageCount: 2,
      failedMessageCount: 2,
      currentFailedMessageIds: failedMessageIds,
      batchAttempt: 1,
      batchAttemptLimit: 3,
    }),
    {
      stage: "running",
      continuation: {
        reason: "retry",
        includeFailed: true,
        batchAttempt: 2,
        messageIds: failedMessageIds,
      },
    },
  );
  assert.deepEqual(
    decideEmbeddingContinuation({
      prerequisites: readyPrerequisites,
      incompleteMessageCount: 2,
      failedMessageCount: 2,
      currentFailedMessageIds: failedMessageIds,
      batchAttempt: 3,
      batchAttemptLimit: 3,
    }),
    { stage: "failed", continuation: null },
  );
});

test("each failure slice receives its own retry budget", () => {
  const firstFailureSlice = ["first-slice-message"];
  const secondFailureSlice = ["second-slice-message"];

  assert.deepEqual(
    decideEmbeddingContinuation({
      prerequisites: readyPrerequisites,
      incompleteMessageCount: 4_000,
      failedMessageCount: 2_000,
      currentFailedMessageIds: firstFailureSlice,
      batchAttempt: 3,
      batchAttemptLimit: 3,
    }),
    {
      stage: "running",
      continuation: {
        reason: "next",
        includeFailed: false,
        batchAttempt: 1,
      },
    },
  );
  assert.deepEqual(
    decideEmbeddingContinuation({
      prerequisites: readyPrerequisites,
      incompleteMessageCount: 4_000,
      failedMessageCount: 4_000,
      currentFailedMessageIds: secondFailureSlice,
      batchAttempt: 1,
      batchAttemptLimit: 3,
    }),
    {
      stage: "running",
      continuation: {
        reason: "retry",
        includeFailed: true,
        batchAttempt: 2,
        messageIds: secondFailureSlice,
      },
    },
  );
});

test("zero candidates and no incomplete messages complete indexing", () => {
  assert.deepEqual(
    decideEmbeddingContinuation({
      prerequisites: readyPrerequisites,
      incompleteMessageCount: 0,
      failedMessageCount: 0,
      currentFailedMessageIds: [],
      batchAttempt: 1,
      batchAttemptLimit: 3,
    }),
    { stage: "complete", continuation: null },
  );
});

test("superseded content prevents a stale complete state", () => {
  assert.deepEqual(
    deriveIndexingProgress({
      persistedStage: "complete",
      prerequisites: readyPrerequisites,
      isModelConfigured: true,
      completedMessageCount: 1_999,
      failedMessageCount: 0,
      totalMessageCount: 2_000,
    }),
    {
      state: "failed",
      completedMessageCount: 1_999,
      failedMessageCount: 0,
      totalMessageCount: 2_000,
    },
  );
});

test("final completion requires every current message embedding", () => {
  assert.deepEqual(
    deriveIndexingProgress({
      persistedStage: "running",
      prerequisites: readyPrerequisites,
      isModelConfigured: true,
      completedMessageCount: 12_573,
      failedMessageCount: 0,
      totalMessageCount: 12_573,
    }),
    {
      state: "complete",
      completedMessageCount: 12_573,
      failedMessageCount: 0,
      totalMessageCount: 12_573,
    },
  );
});

test("failed mailbox prerequisites cannot remain visibly running", () => {
  assert.equal(
    deriveIndexingProgress({
      persistedStage: "running",
      prerequisites: {
        accountStatus: "connected",
        mailSyncStage: "failed",
        replicaState: "failed",
      },
      isModelConfigured: true,
      completedMessageCount: 12_573,
      failedMessageCount: 0,
      totalMessageCount: 20_000,
    }).state,
    "failed",
  );
  assert.equal(
    deriveIndexingProgress({
      persistedStage: "pending",
      prerequisites: {
        accountStatus: "connected",
        mailSyncStage: "failed",
        replicaState: "failed",
      },
      isModelConfigured: true,
      completedMessageCount: 0,
      failedMessageCount: 0,
      totalMessageCount: 0,
    }).state,
    "failed",
  );
});
