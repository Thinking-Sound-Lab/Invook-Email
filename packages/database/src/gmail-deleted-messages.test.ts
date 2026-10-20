import assert from "node:assert/strict";
import test from "node:test";

import { isStaleGmailSnapshotAfterDelete } from "./gmail-deleted-messages";

test("a snapshot at or before the delete history is stale", () => {
  assert.equal(isStaleGmailSnapshotAfterDelete("400", "500"), true);
  assert.equal(isStaleGmailSnapshotAfterDelete("500", "500"), true);
  assert.equal(isStaleGmailSnapshotAfterDelete("600", "500"), false);
});

test("a snapshot or delete without a history id cannot be proven newer", () => {
  assert.equal(isStaleGmailSnapshotAfterDelete(null, "500"), true);
  assert.equal(isStaleGmailSnapshotAfterDelete("500", null), true);
  assert.equal(isStaleGmailSnapshotAfterDelete(undefined, undefined), true);
});

test("non-numeric history ids are treated as stale rather than resurrected", () => {
  assert.equal(isStaleGmailSnapshotAfterDelete("later", "500"), true);
  assert.equal(isStaleGmailSnapshotAfterDelete("500", "later"), true);
});
