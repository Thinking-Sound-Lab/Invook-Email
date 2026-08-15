import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isTerminalQueueFailure,
  mailLabelConcurrency,
  parsePositiveInteger,
  queueNames,
} from "./queue";

test("message label analysis uses a bounded independent queue", () => {
  assert.deepEqual(
    queueNames.filter((queueName) => queueName.startsWith("mail-label")),
    ["mail-label-submit"],
  );
  assert.equal(
    mailLabelConcurrency,
    parsePositiveInteger(
      process.env.MAIL_LABEL_CONCURRENCY,
      5,
      "MAIL_LABEL_CONCURRENCY",
    ),
  );
  assert.equal(parsePositiveInteger(undefined, 5, "TEST_CONCURRENCY"), 5);
  assert.equal(parsePositiveInteger("7", 5, "TEST_CONCURRENCY"), 7);
  assert.throws(
    () => parsePositiveInteger("0", 5, "TEST_CONCURRENCY"),
    /must be a positive integer/i,
  );
});

test("a BullMQ stalled-limit failure is terminal before retry exhaustion", () => {
  assert.equal(
    isTerminalQueueFailure(
      { attemptsMade: 1, opts: { attempts: 5 } },
      new Error("job stalled more than allowable limit"),
    ),
    true,
  );
});

test("an ordinary provider failure remains retryable before attempt exhaustion", () => {
  assert.equal(
    isTerminalQueueFailure(
      { attemptsMade: 1, opts: { attempts: 5 } },
      new Error("provider unavailable"),
    ),
    false,
  );
});

test("an ordinary provider failure is terminal after attempt exhaustion", () => {
  assert.equal(
    isTerminalQueueFailure(
      { attemptsMade: 5, opts: { attempts: 5 } },
      new Error("provider unavailable"),
    ),
    true,
  );
});
