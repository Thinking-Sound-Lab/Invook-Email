import assert from "node:assert/strict";
import test from "node:test";

import { isRelevantMailboxChange } from "./mailbox-event-relevance";

const accountId = "00000000-0000-4000-8000-000000000001";
const openThreadId = "00000000-0000-4000-8000-000000000002";
const otherThreadId = "00000000-0000-4000-8000-000000000003";
const createdAt = "2026-08-17T00:00:00.000Z";

test("open detail follows refreshed history even without a changed list row", () => {
  assert.equal(
    isRelevantMailboxChange(
      {
        accountId,
        createdAt,
        changeType: "history_applied",
        reason: "history_catchup",
        changedThreadIds: [],
        refreshedThreadIds: [openThreadId],
      },
      { surface: "mail", threadId: openThreadId, view: "all" },
    ),
    true,
  );
});

test("unrelated history and draft events do not refresh the visible resource", () => {
  assert.equal(
    isRelevantMailboxChange(
      {
        accountId,
        createdAt,
        changeType: "history_applied",
        reason: "message_refresh",
        changedThreadIds: [otherThreadId],
        refreshedThreadIds: [otherThreadId],
      },
      { surface: "mail", threadId: openThreadId, view: "all" },
    ),
    false,
  );
  assert.equal(
    isRelevantMailboxChange(
      {
        accountId,
        createdAt,
        changeType: "drafts_changed",
        kind: "upsert",
        affectedThreadIds: [otherThreadId],
      },
      { surface: "mail", threadId: null, view: "all" },
    ),
    false,
  );
});

test("label resolution refreshes a mounted list and drafts refresh the drafts view", () => {
  assert.equal(
    isRelevantMailboxChange(
      {
        accountId,
        createdAt,
        changeType: "labels_changed",
        kind: "analysis_resolution",
        affectedThreadIds: [otherThreadId],
      },
      { surface: "mail", threadId: null, view: "important" },
    ),
    true,
  );
  assert.equal(
    isRelevantMailboxChange(
      {
        accountId,
        createdAt,
        changeType: "drafts_changed",
        kind: "delete",
        affectedThreadIds: [otherThreadId],
      },
      { surface: "mail", threadId: null, view: "drafts" },
    ),
    true,
  );
});
