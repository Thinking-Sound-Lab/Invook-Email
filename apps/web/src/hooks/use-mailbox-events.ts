"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function useMailboxEvents(): void {
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
}
