import assert from "node:assert/strict";
import test from "node:test";

import { mailLabelColorClassName } from "./mail-label-colors";

test("mail labels use a stable five-color palette", () => {
  const firstColor = mailLabelColorClassName({ id: "billing", kind: "invook" });
  const repeatedColor = mailLabelColorClassName({
    id: "billing",
    kind: "invook",
  });
  const palette = new Set(
    Array.from({ length: 100 }, (_, index) =>
      mailLabelColorClassName({ id: `label-${index}`, kind: "invook" }),
    ),
  );

  assert.equal(firstColor, repeatedColor);
  assert.equal(palette.size, 5);
});
