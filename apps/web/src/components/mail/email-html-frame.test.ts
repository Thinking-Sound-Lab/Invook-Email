import assert from "node:assert/strict";
import test from "node:test";

import { clampEmailFrameHeight } from "./email-html-frame";

test("email frame height preserves ordinary content within defensive bounds", () => {
  assert.equal(clampEmailFrameHeight(40), 160);
  assert.equal(clampEmailFrameHeight(1_622.2), 1_623);
  assert.equal(clampEmailFrameHeight(500_000), 12_000);
});
