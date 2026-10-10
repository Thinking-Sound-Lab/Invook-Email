"use client";

import { useMailboxEvents } from "@/hooks/use-mailbox-events";

export function MailboxEventSubscriber() {
  const status = useMailboxEvents();
  if (status !== "degraded") return null;
  return (
    <div
      role="alert"
      className="fixed right-4 top-4 z-50 rounded-md bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm"
    >
      Live mailbox updates are unavailable. Reconnecting…
    </div>
  );
}
