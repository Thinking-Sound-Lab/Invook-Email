import assert from "node:assert/strict";
import test from "node:test";

import { listMailRowLabels } from "./mail-row-labels";

test("mail row labels include Gmail user labels and every applied Invook label", () => {
  const labels = listMailRowLabels({
    gmailLabels: [
      {
        id: "gmail-system-label",
        providerLabelId: "INBOX",
        name: "Inbox",
        type: "system",
        color: null,
      },
      {
        id: "gmail-user-label",
        providerLabelId: "Label_1",
        name: "Clients",
        type: "user",
        color: null,
      },
    ],
    invookLabels: [
      {
        labelId: "invook-ai-applied-label",
        name: "Action needed",
        source: "ai",
        confidence: 0.92,
      },
      {
        labelId: "invook-user-applied-label",
        name: "Follow up",
        source: "user",
        confidence: null,
      },
    ],
  });

  assert.deepEqual(labels, [
    { id: "invook-ai-applied-label", kind: "invook", name: "Action needed" },
    { id: "gmail-user-label", kind: "gmail", name: "Clients" },
    { id: "invook-user-applied-label", kind: "invook", name: "Follow up" },
  ]);
});

test("mail row labels exclude every Gmail system label", () => {
  const labels = listMailRowLabels({
    gmailLabels: [
      {
        id: "gmail-system-label",
        providerLabelId: "SPAM",
        name: "Spam",
        type: "system",
        color: null,
      },
    ],
    invookLabels: [],
  });

  assert.deepEqual(labels, []);
});
