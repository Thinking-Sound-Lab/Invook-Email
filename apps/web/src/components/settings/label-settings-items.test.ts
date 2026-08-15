import assert from "node:assert/strict";
import test from "node:test";

import { listLabelSettingsItems } from "./label-settings-items";

test("label settings include Gmail user labels and Invook labels", () => {
  const items = listLabelSettingsItems({
    gmailUserLabels: [{
      id: "gmail-label",
      providerLabelId: "Label_1",
      name: "Clients",
      type: "user",
      color: null,
    }],
    invookLabels: [{
      id: "invook-label",
      name: "Action needed",
      description: "Requires a reply",
      definitionVersion: 1,
      analysisState: "complete",
      analyzedThreadCount: 2,
      totalThreadCount: 2,
    }],
  });

  assert.deepEqual(
    items.map((item) => ({
      id: item.label.id,
      kind: item.kind,
      name: item.label.name,
    })),
    [
      { id: "invook-label", kind: "invook", name: "Action needed" },
      { id: "gmail-label", kind: "gmail", name: "Clients" },
    ],
  );
});
