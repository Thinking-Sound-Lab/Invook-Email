import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import {
  PREVIEW_ACCOUNTS,
  PREVIEW_LABEL_CLASS_NAMES,
  type PreviewAccountKey,
  type PreviewLabelName,
} from "./preview-mailbox";

const stageToneClassNames = {
  dusk: "bg-linear-to-br from-graph-level-1 via-pill-pink to-pill-orange",
  sky: "bg-linear-to-br from-brand-light via-graph-level-1 to-graph-level-2",
  meadow: "bg-linear-to-br from-pill-green via-success-light to-pill-yellow",
} as const;

export interface PreviewStageProps {
  tone?: keyof typeof stageToneClassNames;
  label: string;
  children: ReactNode;
  className?: string;
}

/** A pastel backdrop for a product illustration. Screen readers get the label only. */
export function PreviewStage({ tone = "dusk", label, children, className }: PreviewStageProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn(
        "relative overflow-hidden rounded-3xl",
        stageToneClassNames[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PreviewSurfaceProps {
  children: ReactNode;
  className?: string;
}

/** Renders product UI with the product's dark theme tokens. */
export function PreviewSurface({ children, className }: PreviewSurfaceProps) {
  return (
    <div
      className={cn(
        "dark overflow-hidden rounded-xl bg-background text-foreground shadow-2xl shadow-lp-ink/25",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface PreviewLabelChipProps {
  label: PreviewLabelName;
  className?: string;
}

export function PreviewLabelChip({ label, className }: PreviewLabelChipProps) {
  return (
    <span
      className={cn(
        "min-w-0 max-w-28 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
        PREVIEW_LABEL_CLASS_NAMES[label],
        className,
      )}
    >
      {label}
    </span>
  );
}

export interface PreviewAccountAvatarProps {
  account: PreviewAccountKey;
  className?: string;
}

export function PreviewAccountAvatar({ account, className }: PreviewAccountAvatarProps) {
  const { initials, ringClassName } = PREVIEW_ACCOUNTS[account];

  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[9px] font-semibold text-foreground ring-1 ring-offset-1 ring-offset-background",
        ringClassName,
        className,
      )}
    >
      {initials}
    </span>
  );
}
