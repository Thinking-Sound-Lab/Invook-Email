"use client";

import {
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  InvookLabel,
  InvookThreadLabel,
} from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { setThreadLabel } from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";

export function SmartLabelControls({
  threadId,
  labels,
  availableLabels,
}: SmartLabelControlsProps) {
  const router = useRouter();
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="mt-4">
      <p className="text-xs font-medium text-muted-foreground">
        Labels
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {availableLabels.map((definition) => {
          const current = labels.find((label) => label.labelId === definition.id);
          const applied = Boolean(current);
          return (
            <Button
              key={definition.id}
              type="button"
              size="sm"
              variant={applied ? "secondary" : "ghost"}
              className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground data-[state=on]:text-foreground"
              aria-pressed={applied}
              disabled={pendingLabel !== null}
              onClick={() => void handleSetLabel(definition.id, !applied)}
            >
              <HugeiconsIcon icon={Tag01Icon} size={12} />
              {definition.name}
            </Button>
          );
        })}
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export interface SmartLabelControlsProps {
  threadId: string;
  labels: InvookThreadLabel[];
  availableLabels: InvookLabel[];
}
