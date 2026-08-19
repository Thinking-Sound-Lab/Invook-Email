import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getTemporalCloudConfiguration,
  getWorkflowStartDelay,
  parsePositiveInteger,
} from "./temporal-runtime";

test("Temporal Cloud configuration requires an environment-specific task queue", () => {
  assert.deepEqual(
    getTemporalCloudConfiguration({
      TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
      TEMPORAL_NAMESPACE: "invook.example",
      TEMPORAL_API_KEY: "test-key",
      TEMPORAL_TASK_QUEUE_PREFIX: "invook-test",
    }),
    {
      address: "example.tmprl.cloud:7233",
      namespace: "invook.example",
      apiKey: "test-key",
      taskQueuePrefix: "invook-test",
    },
  );
  assert.throws(
    () =>
      getTemporalCloudConfiguration({
        TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
        TEMPORAL_NAMESPACE: "invook.example",
        TEMPORAL_API_KEY: "test-key",
        TEMPORAL_TASK_QUEUE_PREFIX: "Invalid Prefix",
      }),
    /lowercase letters/i,
  );
});

test("Temporal Activity concurrency is a positive integer", () => {
  assert.equal(parsePositiveInteger(undefined, 5, "TEST_CONCURRENCY"), 5);
  assert.equal(parsePositiveInteger("7", 5, "TEST_CONCURRENCY"), 7);
  assert.throws(
    () => parsePositiveInteger("0", 5, "TEST_CONCURRENCY"),
    /must be a positive integer/i,
  );
});

test("Temporal workflow start delay preserves a future runAt checkpoint", () => {
  const now = Date.parse("2026-08-17T10:00:00.000Z");
  assert.equal(
    getWorkflowStartDelay({ runAt: "2026-08-17T10:05:00.000Z" }, now),
    5 * 60 * 1_000,
  );
  assert.equal(
    getWorkflowStartDelay({ runAt: "2026-08-17T09:55:00.000Z" }, now),
    undefined,
  );
  assert.equal(getWorkflowStartDelay({ runAt: "not-a-date" }, now), undefined);
});
