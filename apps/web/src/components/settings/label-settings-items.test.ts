import assert from "node:assert/strict";
import test from "node:test";

import { listLabelSettingsItems } from "./label-settings-items";

test("label settings keep labels permanent and protect the Others fallback", () => {
  const items = listLabelSettingsItems([
    {
      id: "custom-label",
      name: "Action needed",
      description: "Requires a reply",
      systemKey: null,
      definitionVersion: 1,
      isEnabled: true,
    },
    {
      id: "newsletter-label",
      name: "Newsletter",
      description: "Recurring editorial mail",
      systemKey: "others",
      definitionVersion: 1,
      isEnabled: true,
    },
  ]);

  assert.deepEqual(
    items.map((item) => ({
      id: item.label.id,
      canDisable: item.canDisable,
      name: item.label.name,
    })),
    [
      { id: "custom-label", canDisable: true, name: "Action needed" },
      { id: "newsletter-label", canDisable: false, name: "Newsletter" },
    ],
  );
});
