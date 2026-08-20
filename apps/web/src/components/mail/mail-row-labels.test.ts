import assert from "node:assert/strict";
import test from "node:test";

import { listMailRowLabels } from "./mail-row-labels";

test("mail rows expose the thread's one Invook label", () => {
  const labels = listMailRowLabels({
    invookLabel: {
      labelId: "billing-label",
      name: "Billing",
      source: "ai",
      confidence: 92,
    },
  });

  assert.deepEqual(labels, [
    { id: "billing-label", kind: "invook", name: "Billing" },
  ]);
});

test("mail rows expose no label for provider-only unclassified threads", () => {
  assert.deepEqual(listMailRowLabels({ invookLabel: null }), []);
});
