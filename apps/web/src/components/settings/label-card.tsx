import { Delete02Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailLabel } from "@invook/contracts";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

export interface LabelCardProps {
  label: MailLabel;
  batchConfigured: boolean;
  deleting: boolean;
  onDelete: (label: MailLabel) => Promise<void>;
}

export function LabelCard({
  label,
  batchConfigured,
  deleting,
  onDelete,
}: LabelCardProps) {
  const percentage =
    label.totalThreadCount === 0
      ? label.analysisState === "complete"
        ? 100
        : 0
      : Math.round((label.analyzedThreadCount / label.totalThreadCount) * 100);
  const status =
    label.analysisState === "complete"
      ? `${label.analyzedThreadCount} ${label.analyzedThreadCount === 1 ? "thread" : "threads"} analyzed`
      : label.analysisState === "failed"
        ? "Analysis needs attention"
        : !batchConfigured
          ? "Waiting for Batch setup"
          : label.analysisState === "running"
            ? `${label.analyzedThreadCount} of ${label.totalThreadCount} threads analyzed`
            : "Analysis queued";

  return (
    <article className="rounded-lg bg-card/65 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
          <HugeiconsIcon icon={Tag01Icon} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-semibold">{label.name}</p>
            <div className="flex items-center gap-1.5">
              <p className="text-xs tabular-nums text-muted-foreground">{status}</p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Delete ${label.name}`}
                    disabled={deleting}
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={13} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {label.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes the label and all of its automatic and manual thread
                      decisions. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="border-0">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction disabled={deleting} onClick={() => void onDelete(label)}>
                      Delete label
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">{label.description}</p>
          {label.analysisState !== "complete" ? (
            <Progress
              value={percentage}
              aria-label={`${label.name} analysis progress`}
              className="mt-3 h-1 bg-secondary"
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}
