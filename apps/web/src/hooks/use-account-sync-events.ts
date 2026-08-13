"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function useAccountSyncEvents(): void {
  const router = useRouter();

  useEffect(() => {
    const eventSource = new EventSource("/v1/account-sync/events");
    const refreshAccountSyncState = () => router.refresh();
    eventSource.addEventListener("account-sync", refreshAccountSyncState);

    return () => {
      eventSource.removeEventListener("account-sync", refreshAccountSyncState);
      eventSource.close();
    };
  }, [router]);
}
