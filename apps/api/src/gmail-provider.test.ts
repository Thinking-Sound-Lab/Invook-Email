import assert from "node:assert/strict";
import test from "node:test";

import {
  gmailMessageActionMutation,
  parseGmailThreadReadState,
} from "./routes/gmail-provider";

test("Gmail message actions map only to authoritative provider mutations", () => {
  assert.deepEqual(gmailMessageActionMutation("mark_read"), {
    kind: "labels",
    changes: { removeLabelIds: ["UNREAD"] },
  });
  assert.deepEqual(gmailMessageActionMutation("mark_unread"), {
    kind: "labels",
    changes: { addLabelIds: ["UNREAD"] },
  });
  assert.deepEqual(gmailMessageActionMutation("star"), {
    kind: "labels",
    changes: { addLabelIds: ["STARRED"] },
  });
  assert.deepEqual(gmailMessageActionMutation("unstar"), {
    kind: "labels",
    changes: { removeLabelIds: ["STARRED"] },
  });
  assert.deepEqual(gmailMessageActionMutation("archive"), {
    kind: "labels",
    changes: { removeLabelIds: ["INBOX"] },
  });
  assert.deepEqual(gmailMessageActionMutation("trash"), { kind: "trash" });
});

test("Gmail thread read state accepts only the exact boolean contract", () => {
  assert.deepEqual(parseGmailThreadReadState({ isRead: true }), {
    isRead: true,
  });
  assert.deepEqual(parseGmailThreadReadState({ isRead: false }), {
    isRead: false,
  });
  assert.equal(parseGmailThreadReadState({ isRead: "true" }), null);
  assert.equal(parseGmailThreadReadState({ isRead: true, extra: true }), null);
  assert.equal(parseGmailThreadReadState(null), null);
});
