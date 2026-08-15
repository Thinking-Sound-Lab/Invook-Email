"use client";

import { Add01Icon, TagsIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CreateInvookLabelRequest, InvookLabel } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createInvookLabel, deleteInvookLabel } from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";

import { CreateLabelDialog } from "./create-label-dialog";
import { LabelCard } from "./label-card";

export interface LabelSettingsProps {
  invookLabels: InvookLabel[];
  batchConfigured: boolean;
}

export function LabelSettings({
  invookLabels,
  batchConfigured,
}: LabelSettingsProps) {
  const router = useRouter();
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [deletingLabelId, setDeletingLabelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleOpenEditor() {
    setError(null);
    setIsEditorOpen(true);
  }

  async function handleCreateLabel(request: CreateInvookLabelRequest) {
    await createInvookLabel(request);
    router.refresh();
  }

  async function handleDeleteLabel(label: InvookLabel) {
    setDeletingLabelId(label.id);
    setError(null);
    try {
      await deleteInvookLabel(label.id);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not delete this label."));
    } finally {
      setDeletingLabelId(null);
    }
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
            <HugeiconsIcon icon={TagsIcon} size={17} />
          </span>
          <div>
            <h2 className="text-base font-semibold tracking-[-0.02em]">Invook labels</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
              Invook checks every indexed Gmail thread against each description. New labels
              are analyzed through the configured Batch provider.
            </p>
          </div>
        </div>
        <Button type="button" size="sm" onClick={handleOpenEditor}>
          <HugeiconsIcon icon={Add01Icon} size={14} />
          New label
        </Button>
      </div>

      <div className="mt-6 space-y-2">
        {invookLabels.map((label) => (
          <LabelCard
            key={label.id}
            label={label}
            batchConfigured={batchConfigured}
            deleting={deletingLabelId === label.id}
            onDelete={handleDeleteLabel}
          />
        ))}
        {invookLabels.length === 0 ? (
          <div className="rounded-xl bg-card/45 px-6 py-10 text-center">
            <p className="text-sm font-medium">No labels</p>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Create a label when you want Invook to classify indexed Gmail threads.
            </p>
          </div>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      {isEditorOpen ? (
        <CreateLabelDialog
          onClose={() => setIsEditorOpen(false)}
          onCreate={handleCreateLabel}
        />
      ) : null}
    </section>
  );
}
