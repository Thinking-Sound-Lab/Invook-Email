import { Delete02Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MemoryEntry } from "@invook/contracts";

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

function evidenceLabel(memory: MemoryEntry): string {
  if (memory.source === "user") return "Added by you";
  if (memory.source === "feedback") {
    const count = memory.evidenceDraftIds.length;
    return `Learned from ${count} edited ${count === 1 ? "draft" : "drafts"}`;
  }
  const count = memory.evidenceMessageIds.length;
  return `Learned from ${count} sent ${count === 1 ? "email" : "emails"}`;
}

function sourceLabel(memory: MemoryEntry): string {
  if (memory.source === "user") return "You";
  if (memory.source === "feedback") return "Feedback";
  return "Inferred";
}

export interface MemoryCardProps {
  memory: MemoryEntry;
  onEdit: (memory: MemoryEntry) => void;
  onDelete: (memory: MemoryEntry) => Promise<void>;
}

export function MemoryCard({ memory, onEdit, onDelete }: MemoryCardProps) {
  return (
    <article className="rounded-lg bg-card/65 px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/65" />
            <p className="min-w-0 text-sm leading-6 font-medium">{memory.statement}</p>
          </div>
          <p className="mt-1 pl-4 text-xs leading-5 text-muted-foreground">
            {memory.contactEmail ? `${memory.contactEmail} · ` : ""}
            {evidenceLabel(memory)} · {sourceLabel(memory)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Edit memory"
            onClick={() => onEdit(memory)}
          >
            <HugeiconsIcon icon={Edit02Icon} size={13} />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Delete memory">
                <HugeiconsIcon icon={Delete02Icon} size={13} />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
                <AlertDialogDescription>
                  It will be removed from future drafts. Invook will also remember not to
                  recreate this exact inferred memory.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onDelete(memory)}>
                  Delete memory
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </article>
  );
}
