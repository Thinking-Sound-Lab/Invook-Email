import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDailyGmailWatchRenewalStep,
  createGmailWatchRecoveryStep,
  createImmediateGmailRepairRecoveryStep,
} from "./gmail-watch";
import {
  createGmailSyncMessageBatchSteps,
  createPostSyncDerivationSteps,
  activityTaskQueueForStep,
  activityTaskQueueForStepType,
  GMAIL_SYNC_MESSAGE_BATCH_SIZE,
  TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE,
  temporalCommandPriority,
} from "./workflows";

test("live Gmail work dispatches ahead of bulk synchronization work", () => {
  assert.equal(TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE, 10);
  assert.ok(
    temporalCommandPriority("gmail.history.catchup") <
      temporalCommandPriority("label.message.analyze", {
        dispatchClass: "live",
      }),
  );
  assert.ok(
    temporalCommandPriority("label.message.analyze", {
      dispatchClass: "live",
    }) <
      temporalCommandPriority("gmail.sync.message"),
  );
  assert.equal(
    temporalCommandPriority("label.message.analyze"),
    temporalCommandPriority("gmail.sync.message.batch"),
  );
  assert.equal(
    activityTaskQueueForStepType("gmail.sync.message.batch"),
    "gmail-message-batches",
  );
  assert.equal(
    activityTaskQueueForStep({
      stepType: "label.message.analyze",
      payload: { dispatchClass: "live" },
    }),
    "mail-label-live",
  );
  assert.equal(
    activityTaskQueueForStep({
      stepType: "label.message.analyze",
      payload: {},
    }),
    "mail-label-submit",
  );
});

test("Gmail synchronization pages create stable bounded message batches", () => {
  const providerMessageIds = Array.from(
    { length: GMAIL_SYNC_MESSAGE_BATCH_SIZE * 2 + 3 },
    (_, index) => `message-${index + 1}`,
  );
  const steps = createGmailSyncMessageBatchSteps({
    runId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
    pageNumber: 4,
    providerMessageIds,
  });

  assert.deepEqual(
    steps.map((step) => step.idempotencyKey),
    [
      "gmail-message-batch:11111111-1111-4111-8111-111111111111:4:1",
      "gmail-message-batch:11111111-1111-4111-8111-111111111111:4:2",
      "gmail-message-batch:11111111-1111-4111-8111-111111111111:4:3",
    ],
  );
  assert.deepEqual(
    steps.map((step) => step.payload?.providerMessageIds),
    [
      providerMessageIds.slice(0, GMAIL_SYNC_MESSAGE_BATCH_SIZE),
      providerMessageIds.slice(
        GMAIL_SYNC_MESSAGE_BATCH_SIZE,
        GMAIL_SYNC_MESSAGE_BATCH_SIZE * 2,
      ),
      providerMessageIds.slice(GMAIL_SYNC_MESSAGE_BATCH_SIZE * 2),
    ],
  );
});

test("daily Gmail watch renewal is deterministic and scheduled one day later", () => {
  const input = {
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    renewedAt: new Date("2026-08-13T10:15:30.000Z"),
    expectedExpirationAt: new Date("2026-08-20T10:15:30.000Z"),
  };

  const first = createDailyGmailWatchRenewalStep(input);
  const duplicate = createDailyGmailWatchRenewalStep(input);

  assert.deepEqual(duplicate, first);
  assert.ok(first.payload);
  assert.equal(first.payload.cadence, "daily");
  assert.equal(first.payload.runAt, "2026-08-14T10:15:30.000Z");
  assert.equal(first.payload.expectedExpirationAt, "2026-08-20T10:15:30.000Z");
  assert.equal(
    first.idempotencyKey,
    "gmail-watch-renew:22222222-2222-4222-8222-222222222222:daily:2026-08-14",
  );
  assert.equal(activityTaskQueueForStepType(first.stepType), "gmail-control");
});

test("terminal watch recovery schedules a unique bounded daily successor", () => {
  const step = createGmailWatchRecoveryStep({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    expectedExpirationAt: new Date("2026-08-20T10:00:00.000Z"),
    recoveryKey: "failed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    now: new Date("2026-08-13T10:00:00.000Z"),
  });

  assert.equal(step.payload?.reason, "terminal_failure_recovery");
  assert.equal(step.payload?.runAt, "2026-08-14T10:00:00.000Z");
  assert.equal(
    step.idempotencyKey,
    "gmail-watch-renew:22222222-2222-4222-8222-222222222222:recovery:failed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
});

test("terminal watch recovery runs immediately when expiration is within a day", () => {
  const step = createGmailWatchRecoveryStep({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    expectedExpirationAt: new Date("2026-08-13T20:00:00.000Z"),
    recoveryKey: "near-expiration",
    now: new Date("2026-08-13T10:00:00.000Z"),
  });

  assert.equal(step.payload?.runAt, "2026-08-13T10:00:00.000Z");
});

test("terminal initial synchronization failure creates an immediate repair trigger", () => {
  const step = createImmediateGmailRepairRecoveryStep({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    failedRunId: "33333333-3333-4333-8333-333333333333",
    now: new Date("2026-08-13T10:00:00.000Z"),
  });

  assert.deepEqual(step.payload, {
    cadence: "recovery",
    reason: "terminal_sync_failure_recovery",
    failedRunId: "33333333-3333-4333-8333-333333333333",
    runAt: "2026-08-13T10:00:00.000Z",
  });
  assert.equal(
    step.idempotencyKey,
    "gmail-repair-recovery:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333",
  );
  assert.equal(activityTaskQueueForStepType(step.stepType), "gmail-control");
});

test("ready-replica derivations fan out to independent Temporal Activity task queues", () => {
  const steps = createPostSyncDerivationSteps({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    historyCursor: "987654321",
  });

  assert.deepEqual(
    steps.map((step) => step.stepType),
    ["embedding.backfill", "memory.extract"],
  );
  assert.deepEqual(
    new Set(steps.map((step) => activityTaskQueueForStepType(step.stepType))),
    new Set(["mail-indexing-batch", "mail-memory-submit"]),
  );
  assert.equal(
    activityTaskQueueForStepType("memory.incremental"),
    "mail-memory-submit",
  );
  assert.equal(
    activityTaskQueueForStepType("label.message.analyze"),
    "mail-label-submit",
  );
  assert.equal(
    activityTaskQueueForStepType("label.message.apply"),
    "mail-label-submit",
  );
});
