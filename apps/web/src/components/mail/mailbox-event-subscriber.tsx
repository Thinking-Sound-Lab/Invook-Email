"use client";

import { useMailboxEvents } from "@/hooks/use-mailbox-events";

export function MailboxEventSubscriber() {
  useMailboxEvents();
  return null;
}
