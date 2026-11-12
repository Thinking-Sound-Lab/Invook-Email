import assert from "node:assert/strict";
import { test } from "node:test";

import type { GmailSystemLabelId } from "@invook/gmail";

import {
  coalesceGmailMessageHistoryAction,
  type CoalescedGmailMessageHistoryAction,
} from "./history-actions";

function change(
  action: "upsert" | "labels" | "delete",
  options: {
    providerLabelIds?: GmailSystemLabelId[] | null;
    isDraftRelated?: boolean;
  } = {},
) {
  return {
    messageId: "message-1",
    action,
    providerLabelIds: options.providerLabelIds ?? null,
    isDraftRelated: options.isDraftRelated ?? false,
  };
}

function apply(
  records: Array<{
    action: "upsert" | "labels" | "delete";
    providerHistoryId: string;
    providerLabelIds?: GmailSystemLabelId[] | null;
    isDraftRelated?: boolean;
  }>,
): CoalescedGmailMessageHistoryAction | undefined {
  let current: CoalescedGmailMessageHistoryAction | undefined;
  for (const record of records) {
    current = coalesceGmailMessageHistoryAction(
      current,
      change(record.action, {
        providerLabelIds: record.providerLabelIds,
        isDraftRelated: record.isDraftRelated,
      }),
      record.providerHistoryId,
    );
  }
  return current;
}

test("a later restore after a permanent delete keeps the message", () => {
  assert.deepEqual(
    apply([
      { action: "delete", providerHistoryId: "110" },
      { action: "upsert", providerHistoryId: "111" },
    ]),
    {
      action: "upsert",
      providerHistoryId: "111",
      gmailLabels: null,
      isDraftRelated: false,
    },
  );
});

test("a later permanent delete after an add still removes the message", () => {
  assert.deepEqual(
    apply([
      { action: "upsert", providerHistoryId: "110" },
      { action: "delete", providerHistoryId: "111" },
    ]),
    {
      action: "delete",
      providerHistoryId: "111",
      gmailLabels: null,
      isDraftRelated: false,
    },
  );
});

test("a later delete after label changes still removes the message", () => {
  assert.deepEqual(
    apply([
      {
        action: "labels",
        providerHistoryId: "110",
        providerLabelIds: ["INBOX"],
      },
      { action: "delete", providerHistoryId: "111" },
    ]),
    {
      action: "delete",
      providerHistoryId: "111",
      gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
      isDraftRelated: false,
    },
  );
});

test("a later label change after a delete restores label application", () => {
  assert.deepEqual(
    apply([
      { action: "delete", providerHistoryId: "110" },
      {
        action: "labels",
        providerHistoryId: "111",
        providerLabelIds: ["INBOX", "STARRED"],
      },
    ]),
    {
      action: "labels",
      providerHistoryId: "111",
      gmailLabels: [
        { providerLabelId: "INBOX", name: "Inbox" },
        { providerLabelId: "STARRED", name: "Starred" },
      ],
      isDraftRelated: false,
    },
  );
});

test("an omitted later label snapshot keeps the earlier Gmail labels", () => {
  assert.deepEqual(
    apply([
      {
        action: "labels",
        providerHistoryId: "110",
        providerLabelIds: ["INBOX", "STARRED"],
      },
      { action: "labels", providerHistoryId: "111" },
    ]),
    {
      action: "labels",
      providerHistoryId: "111",
      gmailLabels: [
        { providerLabelId: "INBOX", name: "Inbox" },
        { providerLabelId: "STARRED", name: "Starred" },
      ],
      isDraftRelated: false,
    },
  );
});

test("draft relatedness accumulates across coalesced records", () => {
  const coalesced = apply([
    { action: "delete", providerHistoryId: "110", isDraftRelated: true },
    { action: "upsert", providerHistoryId: "111" },
  ]);
  assert.equal(coalesced?.action, "upsert");
  assert.equal(coalesced?.isDraftRelated, true);
});
