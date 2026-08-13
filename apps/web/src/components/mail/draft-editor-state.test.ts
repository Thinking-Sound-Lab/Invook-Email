import assert from "node:assert/strict";
import test from "node:test";

import type { AiReplyDraft } from "@invook/contracts";

import {
  createDraftEditorState,
  reconcileDraftEditorState,
} from "./draft-editor-state";

function draft(input: Partial<AiReplyDraft> = {}): AiReplyDraft {
  return {
    id: "draft-1",
    threadId: "thread-1",
    status: "editing",
    generatedText: "Generated reply",
    currentText: "Saved reply",
    usedMemoryIds: [],
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...input,
  };
}

test("a thread identity change resets the editor to that thread's draft", () => {
  const current = {
    ...createDraftEditorState({ threadId: "thread-1", draft: draft() }),
    text: "Unsaved reply for thread one",
  };
  const nextDraft = draft({
    id: "draft-2",
    threadId: "thread-2",
    currentText: "Saved reply for thread two",
  });

  const next = reconcileDraftEditorState(current, {
    threadId: "thread-2",
    draft: nextDraft,
  });

  assert.equal(next.threadId, "thread-2");
  assert.equal(next.draft?.id, "draft-2");
  assert.equal(next.text, "Saved reply for thread two");
});

test("a same-draft server refresh updates an untouched editor", () => {
  const current = createDraftEditorState({ threadId: "thread-1", draft: draft() });
  const refreshedDraft = draft({
    currentText: "Updated on the server",
    updatedAt: "2026-08-13T00:01:00.000Z",
  });

  const next = reconcileDraftEditorState(current, {
    threadId: "thread-1",
    draft: refreshedDraft,
  });

  assert.equal(next.draft, refreshedDraft);
  assert.equal(next.text, "Updated on the server");
});

test("a same-draft server refresh preserves unsaved editor text", () => {
  const current = {
    ...createDraftEditorState({ threadId: "thread-1", draft: draft() }),
    text: "My unsaved edit",
  };
  const refreshedDraft = draft({
    currentText: "Updated on the server",
    updatedAt: "2026-08-13T00:01:00.000Z",
  });

  const next = reconcileDraftEditorState(current, {
    threadId: "thread-1",
    draft: refreshedDraft,
  });

  assert.equal(next.draft, refreshedDraft);
  assert.equal(next.text, "My unsaved edit");
});

test("a new draft identity replaces stale editor state", () => {
  const current = {
    ...createDraftEditorState({ threadId: "thread-1", draft: draft() }),
    text: "Edit against the old draft",
  };
  const replacement = draft({ id: "draft-2", currentText: "Replacement draft" });

  const next = reconcileDraftEditorState(current, {
    threadId: "thread-1",
    draft: replacement,
  });

  assert.equal(next.draft, replacement);
  assert.equal(next.text, "Replacement draft");
});
