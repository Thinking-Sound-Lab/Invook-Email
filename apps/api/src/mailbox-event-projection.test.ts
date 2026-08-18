import assert from "node:assert/strict";
import test from "node:test";

import { v4 as uuidv4 } from "uuid";

import {
  parseMailboxNotification,
  projectMailboxChangeEvent,
} from "./mailbox-event-projection";

test("internal mailbox notifications require scoped identifiers", () => {
  const notification = {
    eventId: uuidv4(),
    userId: uuidv4(),
    accountId: uuidv4(),
  };
  assert.deepEqual(parseMailboxNotification(JSON.stringify(notification)), notification);
  assert.equal(parseMailboxNotification(JSON.stringify({ eventId: notification.eventId })), null);
  assert.equal(parseMailboxNotification("not-json"), null);
});

test("stored mailbox events project only the browser-safe contract", () => {
  const accountId = uuidv4();
  const threadId = uuidv4();
  assert.deepEqual(
    projectMailboxChangeEvent({
      accountId,
      changeType: "drafts_changed",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
      payload: { kind: "upsert", affectedThreadIds: [threadId] },
    }),
    {
      accountId,
      changeType: "drafts_changed",
      createdAt: "2026-08-17T00:00:00.000Z",
      kind: "upsert",
      affectedThreadIds: [threadId],
    },
  );
  assert.equal(
    projectMailboxChangeEvent({
      accountId,
      changeType: "drafts_changed",
      createdAt: new Date(),
      payload: { providerMessageId: "provider-secret" },
    }),
    null,
  );
});
