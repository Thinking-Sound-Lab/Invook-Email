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
  threadId: string;
}

export function getThreadReadTrackerKey({
  isUnread,
  threadId,
}: GetThreadReadTrackerKeyInput): string {
  return `${threadId}:${isUnread ? "unread" : "read"}`;
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
