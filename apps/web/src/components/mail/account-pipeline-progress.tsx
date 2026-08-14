"use client";

import {
  Alert02Icon,
  Brain02Icon,
  CloudSyncIcon,
  Loading01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AccountSyncStatusEvent } from "@invook/contracts";

import { Progress } from "@/components/ui/progress";
import { useAccountSyncEvents } from "@/hooks/use-account-sync-events";
import { cn } from "@/lib/utils";

import { getAccountPipelinePresentation } from "./account-pipeline-state";

export interface AccountPipelineProgressProps {
  initialProgress: AccountSyncStatusEvent;
}

export function AccountPipelineProgress({
  initialProgress,
}: AccountPipelineProgressProps) {
  const progress = useAccountSyncEvents(initialProgress);
  const presentation = getAccountPipelinePresentation(progress);
  if (!presentation) return null;

  const icon = presentation.isFailed
    ? Alert02Icon
    : presentation.phase === "mail"
      ? CloudSyncIcon
      : presentation.phase === "indexing"
        ? Loading01Icon
        : Brain02Icon;

  return (
    <div
      role={presentation.isFailed ? "alert" : "status"}
      aria-live="polite"
      className="hidden px-2 pb-1 lg:block"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "grid shrink-0 text-primary",
              presentation.phase === "indexing" && !presentation.isFailed && "motion-safe:animate-spin",
              presentation.isFailed && "text-destructive",
            )}
          >
            <HugeiconsIcon icon={icon} size={14} strokeWidth={1.7} />
          </span>
          <p className="truncate text-[13px] font-semibold text-sidebar-foreground">
            {presentation.title}
          </p>
        </div>
        {presentation.percentage !== null ? (
          <span className="text-xs tabular-nums text-sidebar-foreground/55">
            {presentation.percentage}%
          </span>
        ) : null}
      </div>
      <Progress
        value={presentation.percentage}
        aria-label={presentation.title}
        className={cn(
          "mt-2 h-1 bg-sidebar-accent",
          presentation.isFailed && "[&_[data-slot=progress-indicator]]:bg-destructive",
        )}
      />
      <p className="mt-2 text-xs leading-4 text-sidebar-foreground/48">
        {presentation.detail}
      </p>
    </div>
  );
}
