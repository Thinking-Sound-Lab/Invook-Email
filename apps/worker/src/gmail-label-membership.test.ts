import assert from "node:assert/strict";
import { test } from "node:test";

import { findGmailLabelMembershipMismatches } from "./gmail-label-membership";

test("Gmail label membership comparison ignores order and duplicates", () => {
  assert.deepEqual(
    findGmailLabelMembershipMismatches(
      [
        {
          providerMessageId: "message-1",
          providerLabelIds: ["STARRED", "INBOX", "STARRED"],
        },
      ],
      [
        {
          providerMessageId: "message-1",
          providerLabelIds: ["INBOX", "STARRED"],
        },
      ],
    ),
    [],
  );
});

test("Gmail label membership comparison reports missing membership", () => {
  assert.deepEqual(
    findGmailLabelMembershipMismatches(
      [
        {
          providerMessageId: "message-1",
          providerLabelIds: ["INBOX", "STARRED"],
        },
        {
          providerMessageId: "message-2",
          providerLabelIds: ["SENT"],
        },
      ],
      [
        {
          providerMessageId: "message-1",
          providerLabelIds: ["INBOX"],
        },
      ],
    ),
    [
      {
        providerMessageId: "message-1",
        providerLabelIds: ["INBOX", "STARRED"],
        storedLabelIds: ["INBOX"],
      },
      {
        providerMessageId: "message-2",
        providerLabelIds: ["SENT"],
        storedLabelIds: [],
      },
    ],
  );
});
