import assert from "node:assert/strict";
import { test } from "node:test";

import { createDailyGmailWatchRenewalStep } from "./gmail-watch";
import {
  createPostSyncDerivationSteps,
  queueNameForStepType,
} from "./workflows";

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
  assert.equal(queueNameForStepType(first.stepType), "gmail-control");
});

test("audited-ready derivations fan out to independent BullMQ queues", () => {
  const steps = createPostSyncDerivationSteps({
    userId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    historyCursor: "987654321",
    labels: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", definitionVersion: 2 },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", definitionVersion: 1 },
    ],
  });

  assert.deepEqual(
    steps.map((step) => step.stepType),
    [
      "embedding.backfill",
      "memory.extract",
      "label.backfill.submit",
      "label.backfill.submit",
    ],
  );
  assert.deepEqual(
    new Set(steps.map((step) => queueNameForStepType(step.stepType))),
    new Set(["mail-indexing-batch", "mail-memory-submit", "mail-label-submit"]),
  );
  assert.equal(
    queueNameForStepType("memory.incremental"),
    "mail-memory-submit",
  );
  assert.equal(
    queueNameForStepType("label.batch.event"),
    "mail-label-events",
  );
});
