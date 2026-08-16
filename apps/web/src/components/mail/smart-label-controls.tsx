"use client";

import { Tag01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvookLabel, InvookThreadLabel } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { setThreadLabel } from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";

const MAX_VISIBLE_LABELS = 2;

export interface SmartLabelControlsProps {
  threadId: string;
  labels: InvookThreadLabel[];
  availableLabels: InvookLabel[];
  isOthers: boolean;
}

export function SmartLabelControls({
  threadId,
  labels,
  availableLabels,
  isOthers,
}: SmartLabelControlsProps) {
  const router = useRouter();
  const [isManaging, setIsManaging] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sortedLabels = [...labels].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const visibleLabels = sortedLabels.slice(0, MAX_VISIBLE_LABELS);
  const hiddenLabelCount = sortedLabels.length - visibleLabels.length;
  const showsOthers = isOthers && labels.length === 0;

  async function handleSetLabel(labelId: string, applied: boolean) {
    setPendingLabel(labelId);
    setError(null);
    try {
      await setThreadLabel({ threadId, labelId, applied });
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not save this label."));
    } finally {
      setPendingLabel(null);
    }
  }

  return (
    <div className="relative flex min-w-0 items-center justify-end gap-1.5">
      <div
        className="flex min-w-0 items-center gap-1"
        aria-label={
          visibleLabels.length > 0 || showsOthers ? "Thread labels" : undefined
        }
      >
        {visibleLabels.map((label) => (
          <span
            key={label.labelId}
            className="max-w-28 truncate rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground"
          >
            {label.name}
          </span>
        ))}
        {showsOthers ? (
          <span className="rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground">
            Others
          </span>
        ) : null}
        {hiddenLabelCount > 0 ? (
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
            +{hiddenLabelCount}
          </span>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size={visibleLabels.length > 0 || showsOthers ? "icon-sm" : "sm"}
        aria-label="Manage thread labels"
        aria-expanded={isManaging}
        onClick={() => setIsManaging((current) => !current)}
        className="text-muted-foreground"
      >
        <HugeiconsIcon icon={Tag01Icon} size={15} />
        {visibleLabels.length === 0 && !showsOthers ? <span>Labels</span> : null}
      </Button>

      {isManaging ? (
        <div className="absolute right-0 top-9 z-40 w-64 rounded-xl bg-popover p-2.5 text-popover-foreground shadow-xl ring-1 ring-border/55">
          <p className="px-2 pb-1.5 text-xs font-semibold">Manage labels</p>
          {availableLabels.length > 0 ? (
            <div className="space-y-0.5" role="group" aria-label="Available labels">
              {availableLabels.map((definition) => {
                const isApplied = labels.some(
                  (label) => label.labelId === definition.id,
                );
                return (
                  <Button
                    key={definition.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start gap-2 px-2 text-xs"
                    aria-pressed={isApplied}
                    disabled={pendingLabel !== null}
                    onClick={() =>
                      void handleSetLabel(definition.id, !isApplied)
                    }
                  >
                    <span className="flex size-4 items-center justify-center">
                      {isApplied ? (
                        <HugeiconsIcon icon={Tick02Icon} size={13} />
                      ) : null}
                    </span>
                    <span className="truncate">{definition.name}</span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              No labels are available.
            </p>
          )}
          {error ? (
            <p role="alert" className="px-2 pt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
