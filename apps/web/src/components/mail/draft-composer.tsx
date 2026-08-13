"use client";

import {
  CheckmarkCircle02Icon,
  MailAdd01Icon,
  RefreshIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AiReplyDraft } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  generateReplyDraft,
  saveReplyDraftToGmail,
  updateReplyDraft,
} from "@/lib/api/drafts";
import { apiErrorMessage } from "@/lib/http-error";
import { useDraftEditor } from "@/hooks/use-draft-editor";

export interface DraftComposerProps {
  threadId: string;
  initialDraft: AiReplyDraft | null;
  aiConfigured: boolean;
}

export function DraftComposer({
  threadId,
  initialDraft,
  aiConfigured,
}: DraftComposerProps) {
  const router = useRouter();
  const { draft, text, hasUnsavedChanges, setText, acceptDraft } = useDraftEditor({
    threadId,
    authoritativeDraft: initialDraft,
  });
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<"generate" | "save" | "gmail" | null>(null);
  const [savedToGmail, setSavedToGmail] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerateDraft() {
    setPending("generate");
    setError(null);
    setNotice(null);
    try {
      const generatedDraft = await generateReplyDraft({ threadId, instruction });
      acceptDraft(generatedDraft);
      setSavedToGmail(false);
      setNotice(
        generatedDraft.usedMemoryIds.length > 0
          ? `Drafted with ${generatedDraft.usedMemoryIds.length} relevant ${generatedDraft.usedMemoryIds.length === 1 ? "memory" : "memories"}.`
          : "Drafted from the current conversation. No saved memory was needed.",
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not draft this reply."));
    } finally {
      setPending(null);
    }
  }

  async function handleSaveChanges() {
    if (!draft) return;
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      const savedDraft = await updateReplyDraft({ draftId: draft.id, currentText: text });
      acceptDraft(savedDraft);
      setSavedToGmail(false);
      setNotice(
        savedDraft.currentText === savedDraft.generatedText
          ? "Draft saved."
          : "Changes saved as feedback. Invook learns only when the same edit repeats.",
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not save this draft."));
    } finally {
      setPending(null);
    }
  }

  async function handleSaveToGmailDrafts() {
    if (!draft || hasUnsavedChanges) return;
    setPending("gmail");
    setError(null);
    setNotice(null);
    try {
      await saveReplyDraftToGmail(draft.id);
      setSavedToGmail(true);
      setNotice("Saved to Gmail drafts. Invook kept the AI draft and its evidence unchanged.");
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not save this draft to Gmail."));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-12 rounded-xl bg-card/65 p-4 sm:p-5" aria-label="Draft reply">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={SparklesIcon} size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">Draft with memory</h2>
        </div>
        {draft ? (
          <p className="text-xs text-muted-foreground">
            {draft.usedMemoryIds.length} {draft.usedMemoryIds.length === 1 ? "memory" : "memories"} used
          </p>
        ) : null}
      </div>

      <div className="mt-4 space-y-3">
        <Input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          maxLength={1_000}
          placeholder="Optional instruction for this reply"
          aria-label="Instruction for this reply"
        />

        {draft ? (
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-48 resize-y bg-background/45 text-sm leading-6"
            maxLength={12_000}
            aria-label="Reply draft"
          />
        ) : (
          <div className="rounded-lg bg-background/35 px-5 py-7 text-center">
            <p className="text-sm font-medium">No reply draft yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">
              {aiConfigured
                ? "Invook will use the current thread and only the memories that apply."
                : "Add an AI model before drafting replies."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            When you edit and save, Invook compares your version with its draft. A new memory
            requires the same edit across at least three drafts.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {draft ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleSaveToGmailDrafts()}
                disabled={pending !== null || hasUnsavedChanges || savedToGmail}
              >
                <HugeiconsIcon
                  icon={savedToGmail ? CheckmarkCircle02Icon : MailAdd01Icon}
                  size={13}
                />
                {pending === "gmail"
                  ? "Saving to Gmail…"
                  : savedToGmail
                    ? "Saved to Gmail drafts"
                    : "Save to Gmail drafts"}
              </Button>
            ) : null}
            {draft ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleGenerateDraft()}
                disabled={pending !== null || !aiConfigured}
              >
                <HugeiconsIcon icon={RefreshIcon} size={13} />
                Regenerate
              </Button>
            ) : null}
            {draft ? (
              <Button
                type="button"
                onClick={() => void handleSaveChanges()}
                disabled={pending !== null || !hasUnsavedChanges}
              >
                <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} />
                {pending === "save" ? "Saving…" : "Save changes"}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void handleGenerateDraft()}
                disabled={pending !== null || !aiConfigured}
              >
                <HugeiconsIcon icon={SparklesIcon} size={13} />
                {pending === "generate" ? "Drafting…" : "Draft reply"}
              </Button>
            )}
          </div>
        </div>

        {notice ? <p className="text-xs text-success">{notice}</p> : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
