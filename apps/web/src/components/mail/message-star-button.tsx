"use client";

import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/http-error";
import { setGmailMessageStar } from "@/lib/api/gmail-message-actions";
import { cn } from "@/lib/utils";

export interface MessageStarButtonProps {
  messageId: string;
  isStarred: boolean;
}

export function MessageStarButton({
  messageId,
  isStarred,
}: MessageStarButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = isStarred ? "Remove star from message" : "Star message";

  async function handleStar(): Promise<void> {
    setIsPending(true);
    setError(null);
    try {
      await setGmailMessageStar({ messageId, isStarred: !isStarred });
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not update this star."));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={isStarred}
        aria-busy={isPending}
        disabled={isPending}
        onClick={() => void handleStar()}
        className={cn(
          "text-muted-foreground",
          isStarred && "text-warning hover:text-warning",
        )}
      >
        <HugeiconsIcon
          icon={StarIcon}
          size={16}
          fill={isStarred ? "currentColor" : "none"}
        />
      </Button>
      {error ? (
        <p
          role="alert"
          className="absolute right-0 top-9 z-40 w-56 rounded-lg bg-popover px-3 py-2 text-xs leading-5 text-destructive shadow-xl ring-1 ring-border/55"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
