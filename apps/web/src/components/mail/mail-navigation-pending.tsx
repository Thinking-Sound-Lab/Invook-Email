"use client";

import { Loading01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLinkStatus } from "next/link";

import { cn } from "@/lib/utils";

export interface MailNavigationPendingProps {
  variant?: "inline" | "edge";
}

export function MailNavigationPending({
  variant = "inline",
}: MailNavigationPendingProps) {
  const { pending } = useLinkStatus();

  if (variant === "edge") {
    return (
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary opacity-0 transition-opacity",
          pending && "opacity-100 motion-safe:animate-pulse",
        )}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "ml-auto hidden size-3.5 shrink-0 place-items-center text-sidebar-foreground/60 opacity-0 lg:grid",
        pending && "opacity-100 motion-safe:animate-spin",
      )}
    >
      <HugeiconsIcon icon={Loading01Icon} size={13} />
    </span>
  );
}
