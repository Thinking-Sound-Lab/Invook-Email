"use client";

import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export interface CopyValueButtonProps {
  value: string;
  label: string;
}

/** Copies a value to the clipboard and says so until the value changes. */
export function CopyValueButton({ value, label }: CopyValueButtonProps) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [hasFailed, setHasFailed] = useState(false);
  const isCopied = copiedValue === value;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      setHasFailed(false);
    } catch {
      setHasFailed(true);
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="shrink-0 text-xs"
      onClick={() => void handleCopy()}
      aria-live="polite"
    >
      <HugeiconsIcon icon={isCopied ? Tick02Icon : Copy01Icon} size={13} />
      {hasFailed ? "Copy unavailable" : isCopied ? "Copied" : label}
    </Button>
  );
}
