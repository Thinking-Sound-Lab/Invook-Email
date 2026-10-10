import type {
  MailboxSidebarCounts,
  MailboxShell,
  MailboxThreadDetail,
  MailboxThreadPage,
  MailboxThreadSummary,
} from "@invook/contracts";

export type MailboxPageLoadState = "idle" | "loading" | "error";

export type MailboxThreadDetailLoadState =
  | "loading"
  | "available"
  | "missing"
  | "error";

export interface MailboxThreadDetailRecovery {
  threadId: string;
  loadState: MailboxThreadDetailLoadState;
}

export interface MailboxPageState {
  /**
   * Thread identities in server order, sorted on write so selectors return a
   * stable reference and rows never re-sort during render.
   */
  threadIds: string[];
  olderCursor: string | null;
  loadState: MailboxPageLoadState;
  /**
   * Set when a mailbox change event reconciled a different view, so this page's
   * membership can no longer be trusted. The next API read replaces it instead
   * of merging into it.
   */
  isStale: boolean;
}

export interface HydrateMailboxPageInput {
  key: string;
  page: MailboxThreadPage;
}

export interface AppendMailboxPageInput {
  key: string;
  page: MailboxThreadPage;
}

export interface SetMailboxPageLoadStateInput {
  key: string;
  loadState: MailboxPageLoadState;
}

export interface ApplyMailboxThreadUpdatesInput {
  key: string;
  threads: MailboxThreadSummary[];
  missingThreadIds: string[];
}

export interface PatchMailboxThreadInput {
  threadId: string;
  patch: Partial<MailboxThreadSummary>;
}

export interface HydrateMailboxThreadDetailInput {
  threadId: string;
  detail: MailboxThreadDetail;
}

export interface MailboxState {
  shell: MailboxShell | null;
  /** Fences browser reads started before a canonical cache recovery. */
  recoveryVersion: number;
  recoveringPageKey: string | null;
  threadDetailRecovery: MailboxThreadDetailRecovery | null;
  threadsById: Record<string, MailboxThreadSummary>;
  /**
   * Opened threads, kept so returning to one renders from the cache instead of
   * waiting on the server. A stored message body never changes, so a cached
   * detail is invalidated by a named event or a recovery after missed events.
   */
  detailsById: Record<string, MailboxThreadDetail>;
  pagesByKey: Record<string, MailboxPageState>;
  sidebarCounts: MailboxSidebarCounts | null;
  setShell: (shell: MailboxShell) => void;
  invalidateCaches: (input: { pageKey: string; openThreadId: string | null }) => void;
  completeRecovery: (recoveryVersion: number) => void;
  setThreadDetailRecoveryState: (input: {
    threadId: string;
    recoveryVersion: number;
    loadState: MailboxThreadDetailLoadState;
  }) => void;
  hydratePage: (input: HydrateMailboxPageInput) => void;
  replacePage: (input: HydrateMailboxPageInput) => void;
  appendPage: (input: AppendMailboxPageInput) => void;
  setPageLoadState: (input: SetMailboxPageLoadStateInput) => void;
  applyThreadUpdates: (input: ApplyMailboxThreadUpdatesInput) => void;
  patchThread: (input: PatchMailboxThreadInput) => void;
  hydrateThreadDetail: (input: HydrateMailboxThreadDetailInput) => void;
  removeThreadDetail: (threadId: string) => void;
  setSidebarCounts: (sidebarCounts: MailboxSidebarCounts | null) => void;
  reset: () => void;
}
