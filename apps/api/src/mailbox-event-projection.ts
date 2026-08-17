import {
  parseMailboxChangeEvent,
  type MailboxChangeEvent,
} from "@invook/contracts";
import { validate as validateUuid } from "uuid";

interface StoredMailboxEvent {
  accountId: string;
  changeType: string;
  createdAt: Date;
  payload: unknown;
}

export interface MailboxNotification {
  accountId: string;
  eventId: string;
  userId: string;
}

export function parseMailboxNotification(payload: string): MailboxNotification | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return typeof value.eventId === "string" &&
      validateUuid(value.eventId) &&
      typeof value.userId === "string" &&
      validateUuid(value.userId) &&
      typeof value.accountId === "string" &&
      validateUuid(value.accountId)
      ? {
          eventId: value.eventId,
          userId: value.userId,
          accountId: value.accountId,
        }
      : null;
  } catch {
    return null;
  }
}

export function projectMailboxChangeEvent(
  event: StoredMailboxEvent,
): MailboxChangeEvent | null {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? event.payload
      : {};
  return parseMailboxChangeEvent(
    JSON.stringify({
      ...payload,
      accountId: event.accountId,
      changeType: event.changeType,
      createdAt: event.createdAt.toISOString(),
    }),
  );
}

export function createSafeMailboxInvalidation(event: StoredMailboxEvent): MailboxChangeEvent {
  return {
    accountId: event.accountId,
    changeType: "safe_invalidation",
    createdAt: event.createdAt.toISOString(),
    reason: "legacy_or_malformed",
  };
}
