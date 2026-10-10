"use client";

import type { MailboxThreadDetail } from "@invook/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMailboxStore } from "@/stores/mailbox/store";
import type { MailboxThreadDetailLoadState } from "@/stores/mailbox/types";

import { readMailboxThreadDetail } from "../lib/mailbox-thread-detail-read";

export type ThreadDetailLoadState = MailboxThreadDetailLoadState;

export interface UseThreadDetailProps {
  accountSelection: string;
  threadId: string;
}

export interface UseThreadDetailResult {
  detail: MailboxThreadDetail | null;
  loadState: ThreadDetailLoadState;
  reload: () => void;
}

/**
 * Reads an opened thread, preferring the cache so a revisited thread renders
 * without waiting on the server. A cached thread still revalidates in the
 * background because stored state, not the cache, is authoritative.
 */
export function useThreadDetail({
  accountSelection,
  threadId,
}: UseThreadDetailProps): UseThreadDetailResult {
  const detail = useMailboxStore((state) => state.detailsById[threadId] ?? null);
  const recoveryVersion = useMailboxStore((state) => state.recoveryVersion);
  const threadDetailLoadState = useMailboxStore((state) =>
    state.threadDetailState?.threadId === threadId ? state.threadDetailState.loadState : null,
  );
  const [reloadCount, setReloadCount] = useState(0);
  const recoveryVersionRef = useRef(recoveryVersion);
  const loadState: ThreadDetailLoadState = threadDetailLoadState ?? (detail ? "available" : "loading");

  const reload = useCallback(() => {
    setReloadCount((current) => current + 1);
  }, []);

  useEffect(() => {
    const hasRecoveryVersionChanged = recoveryVersionRef.current !== recoveryVersion;
    recoveryVersionRef.current = recoveryVersion;
    const store = useMailboxStore.getState();
    // Recovery owns this read in the event queue. A version change only aborts
    // the reader's earlier request; it must not create a second cache writer.
    if (
      store.threadDetailState?.threadId === threadId &&
      store.threadDetailState.source === "mailbox" &&
      (hasRecoveryVersionChanged || store.recoveringPageKey !== null)
    ) return;
    const requestController = new AbortController();
    void readMailboxThreadDetail({
      accountSelection,
      threadId,
      signal: requestController.signal,
      source: "reader",
    }).catch(() => {
      // The shared read state already exposes non-cancellation failures.
    });
    return () => requestController.abort();
  }, [
    accountSelection,
    reloadCount,
    recoveryVersion,
    threadId,
  ]);

  return { detail, loadState, reload };
}
