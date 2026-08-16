import assert from "node:assert/strict";
import test from "node:test";

import { listMailRowLabels } from "./mail-row-labels";

test("mail row labels include Gmail Important and every applied Invook label", () => {
  const labels = listMailRowLabels({
    gmailLabels: [
      {
        id: "gmail-system-label",
        providerLabelId: "INBOX",
        name: "Inbox",
        type: "system",
      },
      {
        id: "gmail-important-label",
        providerLabelId: "IMPORTANT",
        name: "Important",
        type: "system",
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
    isOthers: false,
  });

  assert.deepEqual(labels, [
    { id: "invook-ai-applied-label", kind: "invook", name: "Action needed" },
    { id: "invook-user-applied-label", kind: "invook", name: "Follow up" },
    { id: "gmail-important-label", kind: "gmail", name: "Important" },
  ]);
});

test("mail row labels ignore non-Important Gmail system labels", () => {
  const labels = listMailRowLabels({
    gmailLabels: [
      {
        id: "gmail-system-label",
        providerLabelId: "SPAM",
        name: "Spam",
        type: "system",
      },
    ],
    invookLabels: [],
    isOthers: false,
  });

  assert.deepEqual(labels, []);
});

test("mail row labels expose Others from the authoritative derived state", () => {
  const labels = listMailRowLabels({
    gmailLabels: [],
    invookLabels: [],
    isOthers: true,
  });

  assert.deepEqual(labels, [
    { id: "others", kind: "derived", name: "Others" },
  ]);
});

test("mail row labels never combine Others with Important or an Invook label", () => {
  const labels = listMailRowLabels({
    gmailLabels: [
      {
        id: "gmail-important-label",
        providerLabelId: "IMPORTANT",
        name: "Important",
        type: "system",
      },
    ],
    invookLabels: [
      {
        labelId: "security-label",
        name: "Security",
        source: "ai",
        confidence: 0.96,
      },
    ],
    isOthers: true,
  });

  assert.deepEqual(labels, [
    { id: "gmail-important-label", kind: "gmail", name: "Important" },
    { id: "security-label", kind: "invook", name: "Security" },
  ]);
});
