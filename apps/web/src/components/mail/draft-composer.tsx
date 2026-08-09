"use client";

import {
  CheckmarkCircle02Icon,
  RefreshIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ApiProblem, ReplyDraft } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

async function responseError(response: Response, fallback: string) {
  try {
    const problem = (await response.json()) as Partial<ApiProblem>;
    return problem.title || fallback;
  } catch {
    return fallback;
  }
}

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
      const response = await fetch(`/v1/threads/${threadId}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, "Invook could not draft this reply."));
      }
      const body = (await response.json()) as { draft: ReplyDraft };
      setDraft(body.draft);
      setText(body.draft.currentText);
      setNotice(
        body.draft.usedMemoryIds.length > 0
          ? `Drafted with ${body.draft.usedMemoryIds.length} relevant ${body.draft.usedMemoryIds.length === 1 ? "memory" : "memories"}.`
          : "Drafted from the current conversation. No saved memory was needed.",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invook could not draft this reply.");
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
      const response = await fetch(`/v1/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentText: text }),
      });
      if (!response.ok) {
        throw new Error(await responseError(response, "Invook could not save this draft."));
      }
      const body = (await response.json()) as { draft: ReplyDraft };
      setDraft(body.draft);
      setText(body.draft.currentText);
      setNotice(
        body.draft.currentText === body.draft.generatedText
          ? "Draft saved."
          : "Changes saved as feedback. Invook learns only when the same edit repeats.",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invook could not save this draft.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card className="mt-8 border border-border bg-card/55 ring-0">
      <CardHeader className="border-b">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-foreground/[0.06]">
            <HugeiconsIcon icon={SparklesIcon} size={14} />
          </span>
          <CardTitle className="text-sm">Draft with Memory</CardTitle>
        </div>
        {draft ? (
          <Badge variant="outline" className="h-5 text-[9px]">
            {draft.usedMemoryIds.length} used
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
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
            className="min-h-48 resize-y text-[13px] leading-6"
            maxLength={12_000}
            aria-label="Reply draft"
          />
        ) : (
          <div className="rounded-lg border border-dashed px-4 py-6 text-center">
            <p className="text-xs font-medium">No reply draft yet</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {aiConfigured
                ? "Invook will use the current thread and only the memories that apply."
                : "Add an AI model before drafting replies."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-md text-[9px] leading-4 text-muted-foreground">
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

        {notice ? <p className="text-[10px] text-success">{notice}</p> : null}
        {error ? (
          <p role="alert" className="text-[10px] text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
