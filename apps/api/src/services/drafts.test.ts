import assert from "node:assert/strict";
import test from "node:test";

import { selectApplicableDraftMemories } from "./drafts";

test("draft Memory includes only exact-contact rules plus global scopes", () => {
  const memories = [
    { id: "preference", type: "preference", contactEmail: null },
    { id: "scheduling", type: "scheduling", contactEmail: null },
    { id: "exact", type: "contact", contactEmail: "person@example.com" },
    { id: "unrelated", type: "contact", contactEmail: "other@example.com" },
  ];

  assert.deepEqual(
    selectApplicableDraftMemories(
      memories,
      new Set(["person@example.com"]),
    ).map((memory) => memory.id),
    ["preference", "scheduling", "exact"],
  );
});
