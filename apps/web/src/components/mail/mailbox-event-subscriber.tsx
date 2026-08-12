"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function MailboxEventSubscriber() {
  const router = useRouter();

  useEffect(() => {
    const eventSource = new EventSource("/v1/mailbox/events");
    const refreshMailbox = () => router.refresh();
    eventSource.addEventListener("mailbox", refreshMailbox);

    return () => {
      eventSource.removeEventListener("mailbox", refreshMailbox);
      eventSource.close();
    };
  }, [router]);

  return null;
}
