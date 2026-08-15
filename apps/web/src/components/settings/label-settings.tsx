"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  CreateInvookLabelRequest,
  GmailUserLabel,
  InvookLabel,
} from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  createInvookLabel,
  deleteGmailUserLabel,
  deleteInvookLabel,
} from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";

import { CreateLabelDialog } from "./create-label-dialog";
import { listLabelSettingsItems } from "./label-settings-items";
import { LabelSettingsRow } from "./label-settings-row";

export interface LabelSettingsProps {
  gmailUserLabels: GmailUserLabel[];
  invookLabels: InvookLabel[];
  batchConfigured: boolean;
}

export function LabelSettings({
  gmailUserLabels,
  invookLabels,
  batchConfigured,
}: LabelSettingsProps) {
  const router = useRouter();
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [deletingLabelKey, setDeletingLabelKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labels = listLabelSettingsItems({ gmailUserLabels, invookLabels });

  function handleOpenEditor() {
    setError(null);
    setIsEditorOpen(true);
  }

  async function handleCreateLabel(request: CreateInvookLabelRequest) {
    await createInvookLabel(request);
    router.refresh();
  }

  async function handleDeleteGmailLabel(label: GmailUserLabel) {
    setDeletingLabelKey(`gmail:${label.id}`);
    setError(null);
    try {
      await deleteGmailUserLabel(label.id);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not delete this Gmail label."));
    } finally {
      setDeletingLabelKey(null);
    }
  }

  async function handleDeleteInvookLabel(label: InvookLabel) {
    setDeletingLabelKey(`invook:${label.id}`);
    setError(null);
    try {
      await deleteInvookLabel(label.id);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not delete this label."));
    } finally {
      setDeletingLabelKey(null);
    }
  }

  return (
    <section className="w-full px-5 py-6 pr-12 sm:px-8 sm:py-7 sm:pr-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-[-0.025em]">Labels</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={handleOpenEditor}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} />
          New Invook label
        </Button>
      </div>

      <div className="mt-5 space-y-0.5" role="list" aria-label="Gmail and Invook labels">
        {labels.map((item) => {
          if (item.kind === "gmail") {
            return (
              <div key={`gmail:${item.label.id}`} role="listitem">
                <LabelSettingsRow
                  kind="gmail"
                  name={item.label.name}
                  description="Managed in Gmail"
                  status="Synced from Gmail"
                  deleting={deletingLabelKey === `gmail:${item.label.id}`}
                  onDelete={() => handleDeleteGmailLabel(item.label)}
                />
              </div>
            );
          }

          const label = item.label;
          const status =
            label.analysisState === "complete"
              ? `${label.analyzedThreadCount} analyzed`
              : label.analysisState === "failed"
                ? "Analysis needs attention"
                : !batchConfigured
                  ? "Waiting for Batch setup"
                  : label.analysisState === "running"
                    ? `${label.analyzedThreadCount} of ${label.totalThreadCount} analyzed`
                    : "Analysis queued";
          return (
            <div key={`invook:${label.id}`} role="listitem">
              <LabelSettingsRow
                kind="invook"
                name={label.name}
                description={label.description}
                status={status}
                deleting={deletingLabelKey === `invook:${label.id}`}
                onDelete={() => handleDeleteInvookLabel(label)}
              />
            </div>
          );
        })}
        {labels.length === 0 ? (
          <div className="rounded-xl bg-muted/25 px-6 py-12 text-center">
            <p className="text-sm font-medium">No labels</p>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Gmail user labels and Invook labels will appear here.
            </p>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {isEditorOpen ? (
        <CreateLabelDialog
          onClose={() => setIsEditorOpen(false)}
          onCreate={handleCreateLabel}
        />
      ) : null}
    </section>
  );
}
