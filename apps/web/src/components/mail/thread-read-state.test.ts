import assert from "node:assert/strict";
import test from "node:test";

import {
  getThreadReadTrackerKey,
  submitThreadReadAttempt,
} from "./thread-read-state";

test("opening one thread submits only one read mutation while it is pending", async () => {
  const attemptedThreadIds = new Set<string>();
  let completeProviderWrite: () => void = () => {};
  const providerWrite = new Promise<void>((resolve) => {
    completeProviderWrite = resolve;
  });
  let providerWriteCount = 0;
  const markRead = async () => {
    providerWriteCount += 1;
    await providerWrite;
  };

  const firstAttempt = submitThreadReadAttempt({
    attemptedThreadIds,
    markRead,
    threadId: "thread-id",
  });
  assert.equal(
    await submitThreadReadAttempt({
      attemptedThreadIds,
      markRead,
      threadId: "thread-id",
    }),
    "already_attempted",
  );

  completeProviderWrite();
  assert.equal(await firstAttempt, "complete");
  assert.equal(providerWriteCount, 1);
});

test("a failed passive attempt retries only after an explicit reset", async () => {
  const attemptedThreadIds = new Set<string>();
  let shouldFail = true;
  let providerWriteCount = 0;
  const markRead = async () => {
    providerWriteCount += 1;
    if (shouldFail) throw new Error("provider unavailable");
  };

  assert.equal(
    await submitThreadReadAttempt({
      attemptedThreadIds,
      markRead,
      threadId: "thread-id",
    }),
    "failed",
  );
  assert.equal(
    await submitThreadReadAttempt({
      attemptedThreadIds,
      markRead,
      threadId: "thread-id",
    }),
    "already_attempted",
  );

  attemptedThreadIds.delete("thread-id");
  shouldFail = false;
  assert.equal(
    await submitThreadReadAttempt({
      attemptedThreadIds,
      markRead,
      threadId: "thread-id",
    }),
    "complete",
  );
  assert.equal(providerWriteCount, 2);
});

test("canonical read convergence remounts a later unread attempt", () => {
  const unreadKey = getThreadReadTrackerKey({
    threadId: "thread-id",
    isUnread: true,
    providerHistoryIds: ["100"],
  });
  const readKey = getThreadReadTrackerKey({
    threadId: "thread-id",
    isUnread: false,
    providerHistoryIds: ["110"],
  });

  assert.notEqual(unreadKey, readKey);
  assert.equal(
    getThreadReadTrackerKey({
      threadId: "thread-id",
      isUnread: true,
      providerHistoryIds: ["100"],
    }),
    unreadKey,
  );
});

test("coalesced history remounts an unread thread without a boolean transition", () => {
  const beforeCatchup = getThreadReadTrackerKey({
    threadId: "thread-id",
    isUnread: true,
    providerHistoryIds: ["100", null],
  });
  const afterCatchup = getThreadReadTrackerKey({
    threadId: "thread-id",
    isUnread: true,
    providerHistoryIds: ["120", null],
  });

  assert.notEqual(afterCatchup, beforeCatchup);
});
