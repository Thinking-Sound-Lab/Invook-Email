"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";

import {
  parseMailboxChangeEvent,
  shouldRefreshMailboxForEvent,
} from "./mailbox-change-event";

export interface UseMailboxEventsProps {
  selectedThreadId?: string;
}

export function useMailboxEvents({
  selectedThreadId,
}: UseMailboxEventsProps = {}): void {
  const router = useRouter();
  const [isRefreshPending, startRefreshTransition] = useTransition();
  const selectedThreadIdRef = useRef(selectedThreadId);
  const isRefreshPendingRef = useRef(false);
  const hasQueuedRefreshRef = useRef(false);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const refreshMailbox = useCallback(() => {
    if (isRefreshPendingRef.current) {
      hasQueuedRefreshRef.current = true;
      return;
    }
    isRefreshPendingRef.current = true;
    startRefreshTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    isRefreshPendingRef.current = isRefreshPending;
    if (!isRefreshPending && hasQueuedRefreshRef.current) {
      hasQueuedRefreshRef.current = false;
      refreshMailbox();
    }
  }, [isRefreshPending, refreshMailbox]);

  useEffect(() => {
    const eventSource = new EventSource("/v1/mailbox/events");
    const handleMailboxChange = (message: MessageEvent<string>) => {
      const event = parseMailboxChangeEvent(message.data);
      if (
        event &&
        shouldRefreshMailboxForEvent(event, selectedThreadIdRef.current)
      ) {
        refreshMailbox();
      }
    };
    eventSource.addEventListener("mailbox", handleMailboxChange);

    return () => {
      eventSource.removeEventListener("mailbox", handleMailboxChange);
      eventSource.close();
    };
  }, [refreshMailbox]);
}
