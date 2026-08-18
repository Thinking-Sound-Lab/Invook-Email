import type { DatabaseExecutor } from "./client";
import { mailboxChangeEvents } from "./schema";

export type DurableMailboxChange =
  | {
      changeType: "replica_ready";
      payload: Record<string, never>;
    }
  | {
      changeType: "history_applied";
      payload: {
        reason: "history_catchup" | "message_refresh";
        changedThreadIds: string[];
        refreshedThreadIds: string[];
      };
    }
  | {
      changeType: "drafts_changed";
      payload: {
        kind: "snapshot" | "upsert" | "delete";
        affectedThreadIds: string[];
      };
    }
  | {
      changeType: "labels_changed";
      payload: {
        kind: "analysis_resolution" | "decision";
        affectedThreadIds: string[];
      };
    };

export async function insertMailboxChange(
  database: DatabaseExecutor,
  input: { userId: string; accountId: string } & DurableMailboxChange,
): Promise<string> {
  const [event] = await database
    .insert(mailboxChangeEvents)
    .values(input)
    .returning({ id: mailboxChangeEvents.id });
  if (!event) throw new Error("The mailbox change event was not stored.");
  return event.id;
}
