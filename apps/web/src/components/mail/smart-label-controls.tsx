"use client";

import {
  Airplane01Icon,
  HonourStarIcon,
  Megaphone01Icon,
  News01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvookLabelKey, InvookThreadLabel } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

const labelDefinitions = [
  { key: "important", label: "Important", icon: HonourStarIcon },
  { key: "travel", label: "Travel", icon: Airplane01Icon },
  { key: "pitch", label: "Pitch", icon: Megaphone01Icon },
  { key: "newsletter", label: "Newsletter", icon: News01Icon },
] satisfies Array<{
  key: InvookLabelKey;
  label: string;
  icon: typeof HonourStarIcon;
}>;

export function SmartLabelControls({
  threadId,
  initialLabels,
}: {
  threadId: string;
  initialLabels: InvookThreadLabel[];
}) {
  const router = useRouter();
  const [labels, setLabels] = useState(initialLabels);
  const [pendingLabel, setPendingLabel] = useState<InvookLabelKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setLabel(label: InvookLabelKey, applied: boolean) {
    setPendingLabel(label);
    setError(null);
    try {
      const response = await fetch(`/v1/threads/${threadId}/labels`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, applied }),
      });
      if (!response.ok) throw new Error("Invook could not save this label.");
      const body = (await response.json()) as { labels: InvookThreadLabel[] };
      setLabels(body.labels);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invook could not save this label.");
    } finally {
      setPendingLabel(null);
    }
  }

  return (
    <div className="mt-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Invook labels
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {labelDefinitions.map((definition) => {
          const current = labels.find((label) => label.key === definition.key);
          const applied = Boolean(current);
          return (
            <Button
              key={definition.key}
              type="button"
              size="sm"
              variant={applied ? "secondary" : "outline"}
              className="h-7 gap-1.5 px-2 text-[10px]"
              aria-pressed={applied}
              disabled={pendingLabel !== null}
              onClick={() => void setLabel(definition.key, !applied)}
            >
              <HugeiconsIcon icon={definition.icon} size={12} />
              {definition.label}
              {current?.source === "ai" ? (
                <span className="text-[8px] uppercase tracking-wide text-muted-foreground">AI</span>
              ) : null}
            </Button>
          );
        })}
      </div>
      {error ? <p className="mt-2 text-[10px] text-destructive">{error}</p> : null}
    </div>
  );
}
