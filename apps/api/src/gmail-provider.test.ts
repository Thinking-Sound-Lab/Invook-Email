import assert from "node:assert/strict";
import test from "node:test";

import { gmailMessageActionMutation } from "./routes/gmail-provider";

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
