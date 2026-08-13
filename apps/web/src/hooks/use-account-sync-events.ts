"use client";

import type { AccountSyncStatusEvent } from "@invook/contracts";
import { useEffect, useState } from "react";

import { parseAccountSyncStatusEvent } from "@/components/mail/account-pipeline-state";

export function useAccountSyncEvents(
  initialProgress: AccountSyncStatusEvent,
): AccountSyncStatusEvent {
  const [progress, setProgress] = useState(initialProgress);

  useEffect(() => {
    const eventSource = new EventSource("/v1/account-sync/events");
    const updateAccountSyncState = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const nextProgress = parseAccountSyncStatusEvent(event.data);
      if (nextProgress) setProgress(nextProgress);
    };
    eventSource.addEventListener("account-sync", updateAccountSyncState);

    return () => {
      eventSource.removeEventListener("account-sync", updateAccountSyncState);
      eventSource.close();
    };
  }, []);

  return progress;
}
