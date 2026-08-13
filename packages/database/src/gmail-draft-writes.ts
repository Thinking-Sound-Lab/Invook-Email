import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  getDatabase,
  type Database,
} from "./client";
import { gmailDraftWriteOperations } from "./schema";

export type GmailDraftWriteOperation = "create" | "update" | "send";

export type GmailDraftWriteResult = {
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
};

export type BeginGmailDraftWriteResult =
  | { outcome: "claimed"; operationId: string }
  | {
      outcome: "pending";
      operationId: string;
      result: GmailDraftWriteResult | null;
    }
  | {
      outcome: "complete";
      operationId: string;
      result: GmailDraftWriteResult;
    };

export class GmailDraftWriteConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different Gmail draft write.");
    this.name = "GmailDraftWriteConflictError";
  }
}

export async function withGmailDraftSendLock<Result>(
  input: { userId: string; idempotencyKey: string },
  operation: () => Promise<Result>,
  database: Database = getDatabase(),
): Promise<Result> {
  const lockKey = `gmail-draft-send:${input.userId}:${input.idempotencyKey}`;
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    return operation();
  });
}

export async function beginGmailDraftWrite(
  input: {
    userId: string;
    accountId: string;
    operation: GmailDraftWriteOperation;
    idempotencyKey: string;
    requestFingerprint: string;
  },
  database: Database = getDatabase(),
): Promise<BeginGmailDraftWriteResult> {
  const [inserted] = await database
    .insert(gmailDraftWriteOperations)
    .values({
      ...input,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [
        gmailDraftWriteOperations.userId,
        gmailDraftWriteOperations.idempotencyKey,
      ],
    })
    .returning({ id: gmailDraftWriteOperations.id });
  if (inserted) return { outcome: "claimed", operationId: inserted.id };

  const [existing] = await database
    .select({
      id: gmailDraftWriteOperations.id,
      accountId: gmailDraftWriteOperations.accountId,
      operation: gmailDraftWriteOperations.operation,
      status: gmailDraftWriteOperations.status,
      requestFingerprint: gmailDraftWriteOperations.requestFingerprint,
      providerDraftId: gmailDraftWriteOperations.providerDraftId,
      providerMessageId: gmailDraftWriteOperations.providerMessageId,
      providerThreadId: gmailDraftWriteOperations.providerThreadId,
    })
    .from(gmailDraftWriteOperations)
    .where(
      and(
        eq(gmailDraftWriteOperations.userId, input.userId),
        eq(gmailDraftWriteOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("The Gmail draft write idempotency record could not be read.");
  }
  if (
    existing.accountId !== input.accountId ||
    existing.operation !== input.operation ||
    existing.requestFingerprint !== input.requestFingerprint
  ) {
    throw new GmailDraftWriteConflictError();
  }
  if (existing.status === "pending") {
    if (
      existing.providerDraftId &&
      existing.providerMessageId &&
      existing.providerThreadId
    ) {
      return {
        outcome: "pending",
        operationId: existing.id,
        result: {
          providerDraftId: existing.providerDraftId,
          providerMessageId: existing.providerMessageId,
          providerThreadId: existing.providerThreadId,
        },
      };
    }
    return {
      outcome: "pending",
      operationId: existing.id,
      result: null,
    };
  }
  if (
    !existing.providerDraftId ||
    !existing.providerMessageId ||
    !existing.providerThreadId
  ) {
    throw new Error("The completed Gmail draft write has no provider result.");
  }
  return {
    outcome: "complete",
    operationId: existing.id,
    result: {
      providerDraftId: existing.providerDraftId,
      providerMessageId: existing.providerMessageId,
      providerThreadId: existing.providerThreadId,
    },
  };
}

export async function prepareGmailDraftSend(
  input: {
    operationId: string;
    userId: string;
    result: GmailDraftWriteResult;
  },
  database: Database = getDatabase(),
): Promise<void> {
  const [prepared] = await database
    .update(gmailDraftWriteOperations)
    .set({
      providerDraftId: input.result.providerDraftId,
      providerMessageId: input.result.providerMessageId,
      providerThreadId: input.result.providerThreadId,
    })
    .where(
      and(
        eq(gmailDraftWriteOperations.id, input.operationId),
        eq(gmailDraftWriteOperations.userId, input.userId),
        eq(gmailDraftWriteOperations.operation, "send"),
        eq(gmailDraftWriteOperations.status, "pending"),
        or(
          and(
            isNull(gmailDraftWriteOperations.providerDraftId),
            isNull(gmailDraftWriteOperations.providerMessageId),
            isNull(gmailDraftWriteOperations.providerThreadId),
          ),
          and(
            eq(
              gmailDraftWriteOperations.providerDraftId,
              input.result.providerDraftId,
            ),
            eq(
              gmailDraftWriteOperations.providerMessageId,
              input.result.providerMessageId,
            ),
            eq(
              gmailDraftWriteOperations.providerThreadId,
              input.result.providerThreadId,
            ),
          ),
        ),
      ),
    )
    .returning({ id: gmailDraftWriteOperations.id });
  if (prepared) return;

  const [existing] = await database
    .select({
      operation: gmailDraftWriteOperations.operation,
      status: gmailDraftWriteOperations.status,
      providerDraftId: gmailDraftWriteOperations.providerDraftId,
      providerMessageId: gmailDraftWriteOperations.providerMessageId,
      providerThreadId: gmailDraftWriteOperations.providerThreadId,
    })
    .from(gmailDraftWriteOperations)
    .where(
      and(
        eq(gmailDraftWriteOperations.id, input.operationId),
        eq(gmailDraftWriteOperations.userId, input.userId),
      ),
    )
    .limit(1);
  if (
    existing?.operation === "send" &&
    existing.status === "pending" &&
    existing.providerDraftId === input.result.providerDraftId &&
    existing.providerMessageId === input.result.providerMessageId &&
    existing.providerThreadId === input.result.providerThreadId
  ) {
    return;
  }
  throw new Error("The Gmail draft send target could not be persisted.");
}

export async function completeGmailDraftWrite(
  input: {
    operationId: string;
    userId: string;
    result: GmailDraftWriteResult;
  },
  database: Database = getDatabase(),
): Promise<void> {
  const [completed] = await database
    .update(gmailDraftWriteOperations)
    .set({
      status: "complete",
      providerDraftId: input.result.providerDraftId,
      providerMessageId: input.result.providerMessageId,
      providerThreadId: input.result.providerThreadId,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(gmailDraftWriteOperations.id, input.operationId),
        eq(gmailDraftWriteOperations.userId, input.userId),
        eq(gmailDraftWriteOperations.status, "pending"),
      ),
    )
    .returning({ id: gmailDraftWriteOperations.id });
  if (completed) return;

  const [existing] = await database
    .select({
      status: gmailDraftWriteOperations.status,
      providerDraftId: gmailDraftWriteOperations.providerDraftId,
      providerMessageId: gmailDraftWriteOperations.providerMessageId,
      providerThreadId: gmailDraftWriteOperations.providerThreadId,
    })
    .from(gmailDraftWriteOperations)
    .where(
      and(
        eq(gmailDraftWriteOperations.id, input.operationId),
        eq(gmailDraftWriteOperations.userId, input.userId),
      ),
    )
    .limit(1);
  if (
    existing?.status === "complete" &&
    existing.providerDraftId === input.result.providerDraftId &&
    existing.providerMessageId === input.result.providerMessageId &&
    existing.providerThreadId === input.result.providerThreadId
  ) {
    return;
  }
  throw new Error("The Gmail draft write result could not be persisted.");
}

export async function abandonPendingGmailDraftWrite(
  input: { operationId: string; userId: string },
  database: Database = getDatabase(),
): Promise<void> {
  await database
    .delete(gmailDraftWriteOperations)
    .where(
      and(
        eq(gmailDraftWriteOperations.id, input.operationId),
        eq(gmailDraftWriteOperations.userId, input.userId),
        eq(gmailDraftWriteOperations.status, "pending"),
      ),
    );
}

export async function abandonUnpreparedGmailDraftSend(
  input: { operationId: string; userId: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  const [abandoned] = await database
    .delete(gmailDraftWriteOperations)
    .where(
      and(
        eq(gmailDraftWriteOperations.id, input.operationId),
        eq(gmailDraftWriteOperations.userId, input.userId),
        eq(gmailDraftWriteOperations.operation, "send"),
        eq(gmailDraftWriteOperations.status, "pending"),
        isNull(gmailDraftWriteOperations.providerDraftId),
        isNull(gmailDraftWriteOperations.providerMessageId),
        isNull(gmailDraftWriteOperations.providerThreadId),
      ),
    )
    .returning({ id: gmailDraftWriteOperations.id });
  return Boolean(abandoned);
}
