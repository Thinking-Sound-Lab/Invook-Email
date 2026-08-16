"use client";

import { useMailboxEvents } from "@/hooks/use-mailbox-events";

export interface MailboxEventSubscriberProps {
  selectedThreadId?: string;
}

export function MailboxEventSubscriber({
  selectedThreadId,
}: MailboxEventSubscriberProps) {
  useMailboxEvents({ selectedThreadId });
  return null;
}
