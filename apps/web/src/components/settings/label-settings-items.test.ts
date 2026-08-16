import assert from "node:assert/strict";
import test from "node:test";

import { listLabelSettingsItems } from "./label-settings-items";

test("label settings list only Invook labels and protect built-ins", () => {
  const items = listLabelSettingsItems([
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

  assert.deepEqual(
    items.map((item) => ({
      id: item.label.id,
      isDeletable: item.isDeletable,
      name: item.label.name,
    })),
    [
      { id: "custom-label", isDeletable: true, name: "Action needed" },
      { id: "newsletter-label", isDeletable: false, name: "Newsletter" },
    ],
  );
});
