"use client";

import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { requestMailboxSync } from "@/lib/api/mailbox";
import { apiErrorMessage } from "@/lib/http-error";

export function MailboxRefreshButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshMailbox() {
    setPending(true);
    setError(null);
    try {
      await requestMailboxSync();
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not refresh Gmail."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground"
        aria-label={pending ? "Refreshing Gmail" : "Refresh Gmail"}
        disabled={pending}
        onClick={() => void refreshMailbox()}
      >
        <HugeiconsIcon icon={RefreshIcon} size={16} />
      </Button>
    </div>
  );
}
