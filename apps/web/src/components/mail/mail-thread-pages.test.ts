import assert from "node:assert/strict";
import test from "node:test";

import { mergeMailboxThreads } from "./mail-thread-pages";
import type { MailThreadSummary } from "./types";

function thread(id: string, subject = id): MailThreadSummary {
  return {
    id,
    subject,
    snippet: "",
    participants: [],
    gmailLabels: [],
    invookLabels: [],
    latestMessageAt: "2026-08-16T00:00:00.000Z",
    messageCount: 1,
    isOthers: false,
    hasLabelAnalysisFailure: false,
  };
}

test("mailbox pages append without duplicating cursor-boundary threads", () => {
  assert.deepEqual(
    mergeMailboxThreads(
      [thread("first"), thread("boundary")],
      [thread("boundary"), thread("older")],
    ).map((item) => item.id),
    ["first", "boundary", "older"],
  );
});

test("refreshed first-page summaries replace stale stored summaries", () => {
  const merged = mergeMailboxThreads(
    [thread("new"), thread("existing", "Updated subject")],
    [thread("existing", "Stale subject"), thread("older")],
  );

  assert.deepEqual(
    merged.map((item) => [item.id, item.subject]),
    [
      ["new", "new"],
      ["existing", "Updated subject"],
      ["older", "older"],
    ],
  );
});
