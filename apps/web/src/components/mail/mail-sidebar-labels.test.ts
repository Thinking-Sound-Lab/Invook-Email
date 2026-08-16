import assert from "node:assert/strict";
import test from "node:test";

import { listSidebarLabels } from "./mail-sidebar-labels";

test("sidebar labels contain only sorted Invook label definitions", () => {
  const labels = listSidebarLabels([
    {
      id: "custom-label",
      name: "Action needed",
      description: "Requires a reply",
      systemKey: null,
      definitionVersion: 1,
    },
    {
      id: "newsletter-label",
      name: "Newsletter",
      description: "Recurring editorial mail",
      systemKey: "newsletter",
      definitionVersion: 1,
    },
  ]);

  assert.deepEqual(labels, [
    { id: "custom-label", name: "Action needed" },
    { id: "newsletter-label", name: "Newsletter" },
  ]);
});
