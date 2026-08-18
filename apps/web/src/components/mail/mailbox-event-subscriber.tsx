"use client";

import { useMailboxEvents } from "@/hooks/use-mailbox-events";

export function MailboxEventSubscriber() {
  const status = useMailboxEvents();
  if (status === "ready") return null;
  return (
    <div
      role={status === "degraded" ? "alert" : "status"}
      className="fixed right-4 top-4 z-50 rounded-md bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm"
    >
      {status === "degraded"
        ? "Live mailbox updates are reconnecting."
        : "Connecting live mailbox updates…"}
    </div>
  );
}
