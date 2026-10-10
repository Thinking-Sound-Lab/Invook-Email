"use client";

import {
  parseMailboxChangeEvent,
  parseMailboxStreamReadyEvent,
} from "@invook/contracts";
import axios from "axios";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { resolveMailboxAccountSelection } from "@/components/mail/mail-account-scope";
import { useMailShell } from "@/components/mail/mail-shell-provider";
import { planMailboxEvent } from "@/components/mail/mailbox-event-plan";
import { normalizeMailboxView } from "@/components/mail/mailbox-location";
import { getMailboxShell } from "@/lib/api/mailbox-shell";
import {
  getMailboxSidebarCounts,
  getMailboxThreadDetail,
  getMailboxThreadPage,
  getMailboxThreadUpdates,
} from "@/lib/api/mailbox-threads";
import { createMailboxPageKey } from "@/stores/mailbox/mailbox-cache";
import { useMailboxStore } from "@/stores/mailbox/store";

export type MailboxEventStreamStatus = "connecting" | "ready" | "degraded";

function shouldExitMailbox(cause: unknown): boolean {
  return axios.isAxiosError(cause) && (
    cause.response?.status === 401 ||
    (cause.response?.status === 404 && cause.config?.url === "/v1/mailbox/shell")
  );
}

export function useMailboxEvents(): MailboxEventStreamStatus {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accounts } = useMailShell();
  const threadId = searchParams.get("thread");
  const view = normalizeMailboxView(searchParams.get("view"));
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const [status, setStatus] = useState<MailboxEventStreamStatus>("connecting");
  const locationRef = useRef({ accountSelection, threadId, view });
  const handleLocationChangeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    locationRef.current = { accountSelection, threadId, view };
    handleLocationChangeRef.current?.();
  }, [accountSelection, threadId, view]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    let eventSource: EventSource;
    let isRunning = false;
    let shouldRecover = false;
    let isStreamReady = false;
    let hasStreamError = false;
    let hasConnected = false;
    let isRecoveryHealthy = false;
    let consecutiveFailures = 0;
    let requestController: AbortController | null = null;
    const pendingThreadIds = new Set<string>();

    function isCurrentPage(pageKey: string): boolean {
      return createMailboxPageKey(locationRef.current) === pageKey;
    }

    async function readOpenThreadDetail(
      location: { accountSelection: string; threadId: string },
      requestSignal: AbortSignal,
    ): Promise<void> {
      const recoveryVersion = useMailboxStore.getState().recoveryVersion;
      const canApply = () =>
        !requestSignal.aborted &&
        useMailboxStore.getState().recoveryVersion === recoveryVersion &&
        locationRef.current.threadId === location.threadId &&
        locationRef.current.accountSelection === location.accountSelection;
      try {
        const detail = await getMailboxThreadDetail({ ...location, signal: requestSignal });
        if (canApply()) useMailboxStore.getState().hydrateThreadDetail({ threadId: location.threadId, detail });
      } catch (cause: unknown) {
        const isMissing = axios.isAxiosError(cause) && cause.response?.status === 404;
        if (canApply()) {
          if (isMissing) useMailboxStore.getState().removeThreadDetail(location.threadId);
          useMailboxStore.getState().setThreadDetailRecoveryState({
            threadId: location.threadId,
            recoveryVersion,
            loadState: isMissing ? "missing" : "error",
          });
        }
        if (!isMissing) throw cause;
      }
    }

    async function recoverMailbox(requestSignal: AbortSignal): Promise<void> {
      const location = locationRef.current;
      const pageKey = createMailboxPageKey(location);
      useMailboxStore.getState().invalidateCaches({
        pageKey,
        openThreadId: location.threadId,
      });
      const recoveryVersion = useMailboxStore.getState().recoveryVersion;
      const canApply = () =>
        !requestSignal.aborted &&
        useMailboxStore.getState().recoveryVersion === recoveryVersion;

      // Each read publishes independently: a slow shell/counts read must not
      // hold the mail list behind it. Waiting for all reads still fences the
      // next event reconciliation so an older response cannot overwrite it.
      const results = await Promise.allSettled([
        getMailboxThreadPage({ ...location, signal: requestSignal }).then((page) => {
          if (!canApply()) return;
          if (isCurrentPage(pageKey)) {
            useMailboxStore.getState().replacePage({ key: pageKey, page });
          }
        }),
        getMailboxSidebarCounts(requestSignal).then((counts) => {
          if (canApply()) useMailboxStore.getState().setSidebarCounts(counts);
        }),
        getMailboxShell(requestSignal).then((shell) => {
          if (canApply()) useMailboxStore.getState().setShell(shell);
        }),
        location.threadId
          ? readOpenThreadDetail({
              accountSelection: location.accountSelection,
              threadId: location.threadId,
            }, requestSignal)
          : Promise.resolve(),
      ]);
      if (canApply()) useMailboxStore.getState().completeRecovery(recoveryVersion);
      for (const result of results) {
        if (result.status === "rejected" && shouldExitMailbox(result.reason)) {
          const cause: unknown = result.reason;
          throw cause;
        }
      }
      for (const result of results) {
        if (result.status === "rejected") {
          const cause: unknown = result.reason;
          throw cause;
        }
      }
    }

    async function patchMailbox(threadIds: string[], requestSignal: AbortSignal): Promise<void> {
      const location = locationRef.current;
      const pageKey = createMailboxPageKey(location);
      const store = useMailboxStore.getState();
      for (const cachedThreadId of Object.keys(store.detailsById)) {
        if (cachedThreadId !== location.threadId && threadIds.includes(cachedThreadId)) {
          store.removeThreadDetail(cachedThreadId);
        }
      }
      const results = await Promise.allSettled([
        getMailboxThreadUpdates({ ...location, threadIds, signal: requestSignal }).then((updates) => {
          if (requestSignal.aborted) return;
          useMailboxStore.getState().applyThreadUpdates({ key: pageKey, ...updates });
        }),
        getMailboxSidebarCounts(requestSignal).then((counts) => {
          if (!requestSignal.aborted) useMailboxStore.getState().setSidebarCounts(counts);
        }),
        location.threadId && threadIds.includes(location.threadId)
          ? readOpenThreadDetail({
              accountSelection: location.accountSelection,
              threadId: location.threadId,
            }, requestSignal)
          : Promise.resolve(),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          const cause: unknown = result.reason;
          throw cause;
        }
      }
    }

    async function reconcileMailbox(): Promise<void> {
      if (isRunning || signal.aborted) return;
      isRunning = true;
      try {
        while (!signal.aborted && (shouldRecover || pendingThreadIds.size > 0)) {
          const isRecovery = shouldRecover;
          const threadIds = Array.from(pendingThreadIds);
          shouldRecover = false;
          pendingThreadIds.clear();
          requestController = new AbortController();
          const requestSignal = AbortSignal.any([signal, requestController.signal]);
          try {
            if (isRecovery) {
              await recoverMailbox(requestSignal);
              isRecoveryHealthy = !requestSignal.aborted;
            } else {
              await patchMailbox(threadIds, requestSignal);
            }
            if (!requestSignal.aborted && isStreamReady && isRecoveryHealthy) setStatus("ready");
          } catch (cause: unknown) {
            if (signal.aborted) return;
            if (requestSignal.aborted || axios.isCancel(cause)) continue;
            if (shouldExitMailbox(cause)) {
              controller.abort();
              closeStream();
              useMailboxStore.getState().reset();
              router.replace("/");
              return;
            }
            setStatus("degraded");
            isRecoveryHealthy = false;
            // One canonical recovery follows a failed patch. Failed recoveries
            // wait for the next browser/stream event rather than retrying here.
            if (!isRecovery) shouldRecover = true;
          }
        }
      } finally {
        isRunning = false;
      }
    }

    function requestRecovery(options: { shouldInterrupt?: boolean } = {}): void {
      shouldRecover = true;
      isRecoveryHealthy = false;
      if (options.shouldInterrupt) requestController?.abort();
      void reconcileMailbox();
    }

    function handleReady(event: Event): void {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const ready = parseMailboxStreamReadyEvent(event.data);
      if (!ready) return;
      hasConnected = true;
      consecutiveFailures = 0;
      hasStreamError = false;
      isStreamReady = true;
      // Read after subscription as well as on resume: the pre-subscription
      // snapshot alone cannot cover changes made while the stream was closed.
      requestRecovery({ shouldInterrupt: true });
    }

    function handleOpen(): void {
      setStatus((current) => current === "degraded" ? current : "connecting");
    }

    function handleError(): void {
      isStreamReady = false;
      hasStreamError = true;
      consecutiveFailures += 1;
      const isUnavailable = !hasConnected || consecutiveFailures > 1 || !navigator.onLine;
      setStatus((current) => current === "degraded" ? current : isUnavailable ? "degraded" : "connecting");
    }

    function handleMailboxChange(event: Event): void {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      const change = parseMailboxChangeEvent(event.data);
      if (!change) return;
      const plan = planMailboxEvent(change, locationRef.current);
      if (plan.kind === "recover") requestRecovery();
      if (plan.kind === "patch") {
        for (const changedThreadId of plan.threadIds) pendingThreadIds.add(changedThreadId);
        if (!isRecoveryHealthy && !isRunning) shouldRecover = true;
        void reconcileMailbox();
      }
    }

    function connectStream(): void {
      isStreamReady = false;
      hasStreamError = false;
      eventSource = new EventSource("/v1/mailbox/events");
      eventSource.addEventListener("open", handleOpen);
      eventSource.addEventListener("error", handleError);
      eventSource.addEventListener("mailbox-ready", handleReady);
      eventSource.addEventListener("mailbox", handleMailboxChange);
    }

    function closeStream(): void {
      eventSource.removeEventListener("open", handleOpen);
      eventSource.removeEventListener("error", handleError);
      eventSource.removeEventListener("mailbox-ready", handleReady);
      eventSource.removeEventListener("mailbox", handleMailboxChange);
      eventSource.close();
    }

    function handleResume(): void {
      if (document.visibilityState !== "visible") return;
      // Start the list read before opening a replacement stream. Browser SSE
      // retry delays must never gate mailbox freshness on tab return.
      requestRecovery({ shouldInterrupt: true });
      if (hasStreamError || eventSource.readyState === EventSource.CLOSED) {
        closeStream();
        connectStream();
      }
    }

    handleLocationChangeRef.current = () => {
      if (isRunning) requestRecovery({ shouldInterrupt: true });
    };
    connectStream();
    document.addEventListener("visibilitychange", handleResume);
    window.addEventListener("online", handleResume);
    window.addEventListener("pageshow", handleResume);

    return () => {
      controller.abort();
      handleLocationChangeRef.current = null;
      document.removeEventListener("visibilitychange", handleResume);
      window.removeEventListener("online", handleResume);
      window.removeEventListener("pageshow", handleResume);
      closeStream();
    };
  }, [router]);

  return status;
}
