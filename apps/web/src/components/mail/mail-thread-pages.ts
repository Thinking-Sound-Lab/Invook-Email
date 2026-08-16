import type { MailThreadSummary } from "./types";

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
