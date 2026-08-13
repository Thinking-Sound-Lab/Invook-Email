"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function useIndexingEvents(): void {
  const router = useRouter();

  useEffect(() => {
    const eventSource = new EventSource("/v1/indexing/events");
    const refreshIndexingState = () => router.refresh();
    eventSource.addEventListener("indexing", refreshIndexingState);

    return () => {
      eventSource.removeEventListener("indexing", refreshIndexingState);
      eventSource.close();
    };
  }, [router]);
}
