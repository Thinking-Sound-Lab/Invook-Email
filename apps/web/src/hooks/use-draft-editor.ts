"use client";

import type { AiReplyDraft } from "@invook/contracts";
import { useCallback, useState } from "react";

import {
  createDraftEditorState,
  reconcileDraftEditorState,
} from "@/components/mail/draft-editor-state";

export interface UseDraftEditorProps {
  threadId: string;
  authoritativeDraft: AiReplyDraft | null;
}

export interface UseDraftEditorResult {
  draft: AiReplyDraft | null;
  text: string;
  hasUnsavedChanges: boolean;
  setText: (text: string) => void;
  acceptDraft: (draft: AiReplyDraft) => void;
}

export function useDraftEditor({
  threadId,
  authoritativeDraft,
}: UseDraftEditorProps): UseDraftEditorResult {
  const [editor, setEditor] = useState(() =>
    createDraftEditorState({ threadId, draft: authoritativeDraft }),
  );
  const [previousAuthoritative, setPreviousAuthoritative] = useState({
    threadId,
    draft: authoritativeDraft,
  });

  if (
    previousAuthoritative.threadId !== threadId ||
    previousAuthoritative.draft !== authoritativeDraft
  ) {
    setPreviousAuthoritative({ threadId, draft: authoritativeDraft });
    setEditor((current) =>
      reconcileDraftEditorState(current, {
        threadId,
        draft: authoritativeDraft,
      }),
    );
  }

  const setText = useCallback((text: string) => {
    setEditor((current) => ({ ...current, text }));
  }, []);

  const acceptDraft = useCallback((draft: AiReplyDraft) => {
    setEditor(createDraftEditorState({ threadId: draft.threadId, draft }));
  }, []);

  return {
    draft: editor.draft,
    text: editor.text,
    hasUnsavedChanges: Boolean(editor.draft && editor.text !== editor.draft.currentText),
    setText,
    acceptDraft,
  };
}
