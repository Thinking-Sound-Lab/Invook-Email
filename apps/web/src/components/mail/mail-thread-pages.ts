import type { MailThreadSummary } from "./types";

export interface MailThreadPaginationState {
  canonicalPageVersion: string;
  continuationThreads: MailThreadSummary[];
  loadState: "idle" | "loading" | "error";
  olderCursor: string | null;
}

interface ResolveMailThreadPaginationStateInput {
  canonicalPageVersion: string;
  initialOlderCursor: string | null;
  state: MailThreadPaginationState;
}

export function resolveMailThreadPaginationState({
  canonicalPageVersion,
  initialOlderCursor,
  state,
}: ResolveMailThreadPaginationStateInput): MailThreadPaginationState {
  if (state.canonicalPageVersion === canonicalPageVersion) return state;

  return {
    canonicalPageVersion,
    continuationThreads: [],
    loadState: "idle",
    olderCursor: initialOlderCursor,
  };
}

export function mergeMailboxThreads(
  preferredThreads: MailThreadSummary[],
  fallbackThreads: MailThreadSummary[],
): MailThreadSummary[] {
  const threadsById = new Map<string, MailThreadSummary>();
  for (const thread of [...preferredThreads, ...fallbackThreads]) {
    if (!threadsById.has(thread.id)) threadsById.set(thread.id, thread);
  }
  return Array.from(threadsById.values());
}
