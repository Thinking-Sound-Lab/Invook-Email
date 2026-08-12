"use client";

import {
  CheckmarkCircle02Icon,
  RefreshIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReplyDraft } from "@invook/contracts";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/http-error";

export function DraftComposer({
  threadId,
  initialDraft,
  aiConfigured,
}: {
  threadId: string;
  initialDraft: ReplyDraft | null;
  aiConfigured: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [text, setText] = useState(initialDraft?.currentText ?? "");
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<"generate" | "save" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = Boolean(draft && text !== draft.currentText);

  async function generateDraft() {
    setPending("generate");
    setError(null);
    setNotice(null);
    try {
      const response = await axios.post<{ draft: ReplyDraft }>(
        `/v1/threads/${threadId}/drafts`,
        { instruction },
      );
      const body = response.data;
      setDraft(body.draft);
      setText(body.draft.currentText);
      setNotice(
        body.draft.usedMemoryIds.length > 0
          ? `Drafted with ${body.draft.usedMemoryIds.length} relevant ${body.draft.usedMemoryIds.length === 1 ? "memory" : "memories"}.`
          : "Drafted from the current conversation. No saved memory was needed.",
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not draft this reply."));
    } finally {
      setPending(null);
    }
  }

  async function saveChanges() {
    if (!draft) return;
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      const response = await axios.patch<{ draft: ReplyDraft }>(
        `/v1/drafts/${draft.id}`,
        { currentText: text },
      );
      const body = response.data;
      setDraft(body.draft);
      setText(body.draft.currentText);
      setNotice(
        body.draft.currentText === body.draft.generatedText
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
          <div className="flex items-center gap-2">
            {draft ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void generateDraft()}
                disabled={pending !== null || !aiConfigured}
              >
                <HugeiconsIcon icon={RefreshIcon} size={13} />
                Regenerate
              </Button>
            ) : null}
            {draft ? (
              <Button
                type="button"
                onClick={() => void saveChanges()}
                disabled={pending !== null || !changed}
              >
                <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} />
                {pending === "save" ? "Saving…" : "Save changes"}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void generateDraft()}
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
