import assert from "node:assert/strict";
import { test } from "node:test";

import { isTerminalQueueFailure } from "./queue";

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
