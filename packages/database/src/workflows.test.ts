import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDailyGmailWatchRenewalStep,
  createGmailWatchRecoveryStep,
} from "./gmail-watch";
import {
  createPostSyncDerivationSteps,
  activityTaskQueueForStep,
  activityTaskQueueForStepType,
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
    temporalCommandPriority("gmail.sync.message"),
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
