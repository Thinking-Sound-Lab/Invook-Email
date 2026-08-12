import assert from "node:assert/strict";
import { test } from "node:test";

import { gmailHistoryChanges } from "@invook/gmail";

test("Gmail history exposes additions, label changes, and deletions", () => {
  assert.deepEqual(
    gmailHistoryChanges({
      id: "105",
      messagesAdded: [{ message: { id: "added", threadId: "thread-1" } }],
      labelsAdded: [
        {
          message: { id: "starred", threadId: "thread-2" },
          labelIds: ["STARRED"],
        },
      ],
      labelsRemoved: [
        {
          message: { id: "archived", threadId: "thread-3" },
          labelIds: ["INBOX"],
        },
      ],
      messagesDeleted: [
        { message: { id: "deleted", threadId: "thread-4" } },
      ],
    }),
    [
      { messageId: "added", action: "upsert" },
      { messageId: "starred", action: "upsert" },
      { messageId: "archived", action: "upsert" },
      { messageId: "deleted", action: "delete" },
    ],
  );
});
