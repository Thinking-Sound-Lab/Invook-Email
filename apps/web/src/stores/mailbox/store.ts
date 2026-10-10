import type { MailboxThreadSummary } from "@invook/contracts";
import { create } from "zustand";
import { devtools } from "zustand/middleware";

import {
  appendMailboxPageState,
  applyMailboxThreadUpdates,
  hydrateMailboxPageState,
  pruneMailboxThreads,
} from "./mailbox-cache";
import type { MailboxState, MailboxThreadDetailRead } from "./types";

const initialState: Pick<
  MailboxState,
  | "shell"
  | "recoveryVersion"
  | "recoveringPageKey"
  | "threadDetailState"
  | "threadsById"
  | "detailsById"
  | "pagesByKey"
  | "sidebarCounts"
> = {
  shell: null,
  recoveryVersion: 0,
  recoveringPageKey: null,
  threadDetailState: null,
  threadsById: {},
  detailsById: {},
  pagesByKey: {},
  sidebarCounts: null,
};

function withThreads(
  threadsById: Record<string, MailboxThreadSummary>,
  threads: MailboxThreadSummary[],
): Record<string, MailboxThreadSummary> {
  const next = { ...threadsById };
  for (const thread of threads) next[thread.id] = thread;
  return next;
}

export const useMailboxStore = create<MailboxState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      setShell: (shell) => set({ shell }),

      invalidateCaches: ({ pageKey, openThreadId }) =>
        set((state) => ({
          recoveryVersion: state.recoveryVersion + 1,
          recoveringPageKey: pageKey,
          threadDetailState: openThreadId
            ? {
                threadId: openThreadId,
                source: "mailbox",
                recoveryVersion: state.recoveryVersion + 1,
                readVersion: (state.threadDetailState?.readVersion ?? 0) + 1,
                loadState: "loading",
              }
            : null,
          pagesByKey: Object.fromEntries(
            Object.entries(state.pagesByKey).map(([key, page]) => [
              key,
              { ...page, loadState: "idle", isStale: true },
            ]),
          ),
          detailsById: Object.fromEntries(
            Object.entries(state.detailsById).filter(
              ([threadId]) => threadId === openThreadId,
            ),
          ),
        })),

      completeRecovery: (recoveryVersion) =>
        set((state) => state.recoveryVersion === recoveryVersion
          ? { recoveringPageKey: null }
          : state),

      startThreadDetailRead: ({ threadId, source }) => {
        const state = get();
        const read: MailboxThreadDetailRead = {
          threadId,
          source,
          recoveryVersion: state.recoveryVersion,
          readVersion: (state.threadDetailState?.readVersion ?? 0) + 1,
        };
        set({ threadDetailState: { ...read, loadState: "loading" } });
        return read;
      },

      completeThreadDetailRead: ({ read, result }) =>
        set((state) => {
          if (
            state.recoveryVersion !== read.recoveryVersion ||
            state.threadDetailState?.threadId !== read.threadId ||
            state.threadDetailState.readVersion !== read.readVersion
          ) return state;
          const threadDetailState = { ...read, loadState: result.loadState };
          switch (result.loadState) {
            case "available":
              return {
                threadDetailState,
                detailsById: { ...state.detailsById, [read.threadId]: result.detail },
              };
            case "missing":
              return {
                threadDetailState,
                detailsById: Object.fromEntries(
                  Object.entries(state.detailsById).filter(([threadId]) => threadId !== read.threadId),
                ),
              };
            case "error":
              return { threadDetailState };
          }
        }),

      replacePage: ({ key, page }) =>
        set((state) => {
          const threadsById = withThreads(state.threadsById, page.threads);
          const pagesByKey = {
            ...state.pagesByKey,
            [key]: hydrateMailboxPageState({ existing: undefined, page, threadsById }),
          };
          return {
            threadsById: pruneMailboxThreads(threadsById, pagesByKey),
            pagesByKey,
          };
        }),

      hydratePage: ({ key, page }) =>
        set((state) => {
          const threadsById = withThreads(state.threadsById, page.threads);
          return {
            threadsById,
            pagesByKey: {
              ...state.pagesByKey,
              [key]: hydrateMailboxPageState({
                existing: state.pagesByKey[key],
                page,
                threadsById,
              }),
            },
          };
        }),

      appendPage: ({ key, page }) =>
        set((state) => {
          const threadsById = withThreads(state.threadsById, page.threads);
          return {
            threadsById,
            pagesByKey: {
              ...state.pagesByKey,
              [key]: appendMailboxPageState({
                existing: state.pagesByKey[key],
                page,
                threadsById,
              }),
            },
          };
        }),

      setPageLoadState: ({ key, loadState }) =>
        set((state) => {
          const page = state.pagesByKey[key];
          if (!page || page.loadState === loadState) return state;
          return {
            pagesByKey: { ...state.pagesByKey, [key]: { ...page, loadState } },
          };
        }),

      applyThreadUpdates: ({ key, threads, missingThreadIds }) =>
        set((state) =>
          applyMailboxThreadUpdates({
            key,
            missingThreadIds,
            pagesByKey: state.pagesByKey,
            threads,
            threadsById: state.threadsById,
          }),
        ),

      patchThread: ({ threadId, patch }) =>
        set((state) => {
          const thread = state.threadsById[threadId];
          if (!thread) return state;
          return {
            threadsById: {
              ...state.threadsById,
              [threadId]: { ...thread, ...patch },
            },
          };
        }),

      hydrateThreadDetail: ({ threadId, detail }) =>
        set((state) => {
          if (state.threadDetailState?.threadId === threadId && state.threadDetailState.loadState !== "available") return state;
          return { detailsById: { ...state.detailsById, [threadId]: detail } };
        }),

      removeThreadDetail: (threadId) =>
        set((state) => {
          if (!state.detailsById[threadId]) return state;
          return {
            detailsById: Object.fromEntries(
              Object.entries(state.detailsById).filter(
                ([cachedThreadId]) => cachedThreadId !== threadId,
              ),
            ),
          };
        }),

      setSidebarCounts: (sidebarCounts) => set({ sidebarCounts }),

      reset: () => set((state) => ({
        ...initialState,
        recoveryVersion: state.recoveryVersion + 1,
      })),
    }),
    { name: "mailbox-store" },
  ),
);
