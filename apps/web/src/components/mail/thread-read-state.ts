export type ThreadReadAttemptResult =
  | "already_attempted"
  | "complete"
  | "failed";

export interface SubmitThreadReadAttemptInput {
  attemptedThreadIds: Set<string>;
  markRead: (threadId: string) => Promise<void>;
  threadId: string;
}

export interface GetThreadReadTrackerKeyInput {
  isUnread: boolean;
  providerHistoryIds: Array<string | null>;
  threadId: string;
}

export function getThreadReadTrackerKey({
  isUnread,
  providerHistoryIds,
  threadId,
}: GetThreadReadTrackerKeyInput): string {
  const providerHistoryVersion = providerHistoryIds
    .map((providerHistoryId) => providerHistoryId ?? "")
    .sort()
    .join(",");
  return `${threadId}:${isUnread ? "unread" : "read"}:${providerHistoryVersion}`;
}

export async function submitThreadReadAttempt({
  attemptedThreadIds,
  markRead,
  threadId,
}: SubmitThreadReadAttemptInput): Promise<ThreadReadAttemptResult> {
  if (attemptedThreadIds.has(threadId)) return "already_attempted";
  attemptedThreadIds.add(threadId);

  try {
    await markRead(threadId);
    return "complete";
  } catch {
    return "failed";
  }
}
