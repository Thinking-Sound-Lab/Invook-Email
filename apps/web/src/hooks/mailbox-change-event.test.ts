import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMailboxChangeEvent,
  shouldRefreshMailboxForEvent,
} from "./mailbox-change-event";

const eventId = "10000000-0000-4000-8000-000000000001";
const accountId = "10000000-0000-4000-8000-000000000002";
const openThreadId = "10000000-0000-4000-8000-000000000003";
const otherThreadId = "10000000-0000-4000-8000-000000000004";

test("mailbox events retain their changed thread identities", () => {
  assert.deepEqual(
    parseMailboxChangeEvent(JSON.stringify({
      id: eventId,
      accountId,
      changeType: "labels_changed",
      changedThreadIds: [otherThreadId],
      createdAt: "2026-08-16T10:00:00.000Z",
    })),
    {
      id: eventId,
      accountId,
      changeType: "labels_changed",
      changedThreadIds: [otherThreadId],
      createdAt: "2026-08-16T10:00:00.000Z",
    },
  );
});

test("an open thread ignores mailbox changes for other threads", () => {
  const event = parseMailboxChangeEvent(JSON.stringify({
    id: eventId,
    accountId,
    changeType: "labels_changed",
    changedThreadIds: [otherThreadId],
    createdAt: "2026-08-16T10:00:00.000Z",
  }));
  assert.ok(event);

  assert.equal(shouldRefreshMailboxForEvent(event, openThreadId), false);
  assert.equal(shouldRefreshMailboxForEvent(event, otherThreadId), true);
  assert.equal(shouldRefreshMailboxForEvent(event), true);
});

test("global events still refresh an open thread", () => {
  const event = parseMailboxChangeEvent(JSON.stringify({
    id: eventId,
    accountId,
    changeType: "replica_ready",
    changedThreadIds: [],
    createdAt: "2026-08-16T10:00:00.000Z",
  }));
  assert.ok(event);

  assert.equal(shouldRefreshMailboxForEvent(event, openThreadId), true);
});

test("invalid mailbox events are ignored", () => {
  assert.equal(parseMailboxChangeEvent("{"), null);
  assert.equal(parseMailboxChangeEvent(JSON.stringify({
    id: eventId,
    accountId,
    changeType: "labels_changed",
    changedThreadIds: ["not-a-thread-id"],
    createdAt: "2026-08-16T10:00:00.000Z",
  })), null);
});
