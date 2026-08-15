import assert from "node:assert/strict";
import test from "node:test";

import { listSidebarLabels } from "./mail-sidebar-labels";

test("sidebar labels combine Gmail user labels and Invook labels", () => {
  const labels = listSidebarLabels({
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

  assert.deepEqual(labels, [
    { id: "invook-label", name: "Action needed", kind: "invook" },
    { id: "gmail-label", name: "Clients", kind: "gmail" },
  ]);
});
