"use client";

import { Tag01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvookLabel, InvookThreadLabel } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { setThreadLabel } from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";

export interface SmartLabelControlsProps {
  threadId: string;
  label: InvookThreadLabel | null;
  availableLabels: InvookLabel[];
}

export function SmartLabelControls({
  threadId,
  label,
  availableLabels,
}: SmartLabelControlsProps) {
  const router = useRouter();
  const [isManaging, setIsManaging] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function handleSetLabel(labelId: string) {
    if (label?.labelId === labelId) {
      setIsManaging(false);
      return;
    }
    setPendingLabel(labelId);
    setError(null);
    try {
      await setThreadLabel({ threadId, labelId });
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
        aria-label={label ? "Thread label" : undefined}
      >
        {label ? (
          <span
            key={label.labelId}
            className="max-w-28 truncate rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground"
          >
            {label.name}
          </span>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size={label ? "icon-sm" : "sm"}
        aria-label="Manage thread labels"
        aria-expanded={isManaging}
        onClick={() => setIsManaging((current) => !current)}
        className="text-muted-foreground"
      >
        <HugeiconsIcon icon={Tag01Icon} size={15} />
        {!label ? <span>Labels</span> : null}
      </Button>

      {isManaging ? (
        <div className="absolute right-0 top-9 z-40 w-64 rounded-xl bg-popover p-2.5 text-popover-foreground shadow-xl ring-1 ring-border/55">
          <p className="px-2 pb-1.5 text-xs font-semibold">Manage labels</p>
          {availableLabels.length > 0 ? (
            <div className="space-y-0.5" role="group" aria-label="Available labels">
              {availableLabels.map((definition) => {
                const isApplied = label?.labelId === definition.id;
                return (
                  <Button
                    key={definition.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start gap-2 px-2 text-xs"
                    aria-pressed={isApplied}
                    disabled={pendingLabel !== null}
                    onClick={() => void handleSetLabel(definition.id)}
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
