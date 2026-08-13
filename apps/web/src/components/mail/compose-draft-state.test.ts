import assert from "node:assert/strict";
import test from "node:test";

import {
  composeDraftReducer,
  createComposeDraftState,
} from "./compose-draft-state";

test("a failed save preserves the idempotency key for an exact retry", () => {
  const initial = createComposeDraftState("save-key-1");
  const saving = composeDraftReducer(initial, { type: "saving" });
  const failed = composeDraftReducer(saving, {
    type: "error",
    message: "Gmail is unavailable.",
  });

  assert.equal(failed.idempotencyKey, "save-key-1");
  assert.equal(failed.status, "error");
});

test("editing after a save rotates the key and retains the provider draft identity", () => {
  const saved = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "saved",
    draft: {
      providerDraftId: "provider-draft",
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    },
  });
  const edited = composeDraftReducer(saved, {
    type: "edit",
    field: "body",
    value: "Revised body",
    idempotencyKey: "save-key-2",
  });

  assert.equal(edited.idempotencyKey, "save-key-2");
  assert.equal(edited.status, "editing");
  assert.equal(edited.providerDraft?.providerDraftId, "provider-draft");
});

test("a successful save exposes an explicit convergence state", () => {
  const saved = composeDraftReducer(createComposeDraftState("save-key-1"), {
    type: "saved",
    draft: {
      providerDraftId: "provider-draft",
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    },
  });

  assert.equal(saved.status, "saved");
  assert.match(saved.message ?? "", /Gmail history catches up/);
});
