import type { MailboxChangeEvent } from "@invook/contracts";
import { validate as validateUuid } from "uuid";

const mailboxChangeTypes = [
  "replica_ready",
  "history_applied",
  "repair_complete",
  "drafts_changed",
  "labels_changed",
] satisfies MailboxChangeEvent["changeType"][];

function isMailboxChangeType(
  value: unknown,
): value is MailboxChangeEvent["changeType"] {
  return (
    typeof value === "string" &&
    mailboxChangeTypes.some((changeType) => changeType === value)
  );
}

export function parseMailboxChangeEvent(data: string): MailboxChangeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const id = "id" in value ? value.id : undefined;
  const accountId = "accountId" in value ? value.accountId : undefined;
  const changeType = "changeType" in value ? value.changeType : undefined;
  const createdAt = "createdAt" in value ? value.createdAt : undefined;
  const rawChangedThreadIds =
    "changedThreadIds" in value ? value.changedThreadIds : [];
  if (
    typeof id !== "string" ||
    !validateUuid(id) ||
    typeof accountId !== "string" ||
    !validateUuid(accountId) ||
    !isMailboxChangeType(changeType) ||
    typeof createdAt !== "string" ||
    !Array.isArray(rawChangedThreadIds) ||
    !rawChangedThreadIds.every(
      (threadId) => typeof threadId === "string" && validateUuid(threadId),
    )
  ) {
    return null;
  }

  return {
    id,
    accountId,
    changeType,
    changedThreadIds: rawChangedThreadIds,
    createdAt,
  };
}

export function shouldRefreshMailboxForEvent(
  event: MailboxChangeEvent,
  selectedThreadId?: string,
): boolean {
  if (!selectedThreadId || event.changedThreadIds.length === 0) return true;
  return event.changedThreadIds.includes(selectedThreadId);
}
