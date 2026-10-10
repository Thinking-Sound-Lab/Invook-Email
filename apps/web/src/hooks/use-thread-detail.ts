"use client";

import type { MailboxThreadDetail } from "@invook/contracts";
import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";

import { getMailboxThreadDetail } from "@/lib/api/mailbox-threads";
import { useMailboxStore } from "@/stores/mailbox/store";
import type { MailboxThreadDetailLoadState } from "@/stores/mailbox/types";

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

interface ThreadDetailRequestResult {
  threadId: string;
  recoveryVersion: number;
  status: Exclude<ThreadDetailLoadState, "loading">;
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
  const recoveryLoadState = useMailboxStore((state) =>
    state.threadDetailRecovery?.threadId === threadId ? state.threadDetailRecovery.loadState : null,
  );
  const hydrateThreadDetail = useMailboxStore(
    (state) => state.hydrateThreadDetail,
  );
  const removeThreadDetail = useMailboxStore(
    (state) => state.removeThreadDetail,
  );
  const [result, setResult] = useState<ThreadDetailRequestResult | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const recoveryVersionRef = useRef(recoveryVersion);
  const loadState: ThreadDetailLoadState =
    result?.threadId === threadId && result.recoveryVersion === recoveryVersion
      ? result.status
      : recoveryLoadState ?? (detail ? "available" : "loading");

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
      store.threadDetailRecovery?.threadId === threadId &&
      (hasRecoveryVersionChanged || store.recoveringPageKey !== null)
    ) return;
    const requestController = new AbortController();
    void (async () => {
      try {
        const nextDetail = await getMailboxThreadDetail({
          accountSelection,
          threadId,
          signal: requestController.signal,
        });
        if (
          requestController.signal.aborted ||
          useMailboxStore.getState().recoveryVersion !== recoveryVersion
        ) return;
        hydrateThreadDetail({ threadId, detail: nextDetail });
        setResult({ threadId, recoveryVersion, status: "available" });
      } catch (cause: unknown) {
        if (
          axios.isCancel(cause) ||
          requestController.signal.aborted ||
          useMailboxStore.getState().recoveryVersion !== recoveryVersion
        ) return;
        const status =
          axios.isAxiosError(cause) && cause.response?.status === 404
            ? "missing"
            : "error";
        if (status === "missing") removeThreadDetail(threadId);
        setResult({ threadId, recoveryVersion, status });
      }
    })();
    return () => requestController.abort();
  }, [
    accountSelection,
    hydrateThreadDetail,
    reloadCount,
    recoveryVersion,
    removeThreadDetail,
    threadId,
  ]);

  return { detail, loadState, reload };
}
