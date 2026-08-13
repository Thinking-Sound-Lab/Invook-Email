import type { AiReplyDraft } from "@invook/contracts";

export interface DraftEditorState {
  threadId: string;
  draft: AiReplyDraft | null;
  text: string;
}

export interface CreateDraftEditorStateInput {
  threadId: string;
  draft: AiReplyDraft | null;
}

export function createDraftEditorState({
  threadId,
  draft,
}: CreateDraftEditorStateInput): DraftEditorState {
  return {
    threadId,
    draft,
    text: draft?.currentText ?? "",
  };
}

export function reconcileDraftEditorState(
  current: DraftEditorState,
  authoritative: CreateDraftEditorStateInput,
): DraftEditorState {
  if (
    current.threadId !== authoritative.threadId ||
    current.draft?.id !== authoritative.draft?.id
  ) {
    return createDraftEditorState(authoritative);
  }

  if (!authoritative.draft || !current.draft) {
    return current;
  }

  const hasUnsavedChanges = current.text !== current.draft.currentText;
  return {
    threadId: authoritative.threadId,
    draft: authoritative.draft,
    text: hasUnsavedChanges ? current.text : authoritative.draft.currentText,
  };
}
