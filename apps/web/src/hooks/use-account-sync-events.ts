"use client";

import type { AccountSyncStatusEvent } from "@invook/contracts";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { parseAccountSyncStatusEvent } from "@/components/mail/account-pipeline-state";
import { useAccountSyncStore } from "@/stores/account-sync/store";

export function useAccountSyncEvents(
  initialProgress: AccountSyncStatusEvent,
): AccountSyncStatusEvent {
  const router = useRouter();
  const storedProgress = useAccountSyncStore((state) => state.progress);
  const setProgress = useAccountSyncStore((state) => state.setProgress);
  const reset = useAccountSyncStore((state) => state.reset);

  useEffect(() => {
    if (!useAccountSyncStore.getState().progress) setProgress(initialProgress);
    const eventSource = new EventSource("/v1/account-sync/events");
    const updateAccountSyncState = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const nextProgress = parseAccountSyncStatusEvent(event.data);
      if (!nextProgress) return;
      const previousProgress = useAccountSyncStore.getState().progress ?? initialProgress;
      setProgress(nextProgress);
      if (
        previousProgress.memory !== "complete" &&
        nextProgress.memory === "complete"
      ) {
        router.refresh();
      }
    };
    eventSource.addEventListener("account-sync", updateAccountSyncState);

    return () => {
      eventSource.removeEventListener("account-sync", updateAccountSyncState);
      eventSource.close();
    };
  }, [initialProgress, router, setProgress]);

  useEffect(() => () => reset(), [reset]);

  return storedProgress ?? initialProgress;
}
