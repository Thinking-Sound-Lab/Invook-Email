import { and, asc, desc, eq, gt, inArray, isNotNull, not, or } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { getDatabase, type Database } from "./client";
import { deleteIndexedMessage, upsertIndexedMessage } from "./repositories";
import {
  connectedAccounts,
  accountSecrets,
  drafts,
  gmailAccountCleanups,
  gmailDrafts,
  gmailLabels,
  gmailMessageLabels,
  gmailMessageTombstones,
  gmailPushEvents,
  gmailReplicaAudits,
  gmailReplicaStates,
  gmailWatchStates,
  mailboxChangeEvents,
  messageAttachments,
  messages,
  threads,
} from "./schema";
import type { IndexedMessage } from "./types";
import { enqueueWorkflowStep } from "./workflows";

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type GmailProviderLabelInput = {
  providerLabelId: string;
  name: string;
  type: "system" | "user";
  messageListVisibility: string | null;
  labelListVisibility: string | null;
  color: { textColor?: string; backgroundColor?: string } | null;
  providerMetadata: Record<string, unknown>;
};

export type GmailDraftResourceInput = {
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
  providerHistoryId: string | null;
  providerMetadata: Record<string, unknown>;
};

export type GmailWatchInput = {
  topicName: string;
  historyId: string;
  expirationAt: Date;
};

export async function getGmailProviderWriteContext(
  userId: string,
  database: Database = getDatabase(),
) {
  const [context] = await database
    .select({
      userId: connectedAccounts.userId,
      accountId: connectedAccounts.id,
      email: connectedAccounts.email,
      tokenCiphertext: accountSecrets.tokenCiphertext,
      replicaState: gmailReplicaStates.state,
    })
    .from(connectedAccounts)
    .innerJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  return context ?? null;
}

export async function getGmailProviderLabelForUser(
  input: { userId: string; gmailLabelId: string },
  database: Database = getDatabase(),
) {
  const [label] = await database
    .select({
      id: gmailLabels.id,
      providerLabelId: gmailLabels.providerLabelId,
      type: gmailLabels.type,
      accountId: gmailLabels.accountId,
    })
    .from(gmailLabels)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, gmailLabels.accountId))
    .where(
      and(
        eq(gmailLabels.id, input.gmailLabelId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  return label ?? null;
}

export async function getGmailMessageLabelMutationContext(
  input: { userId: string; messageId: string; gmailLabelIds: string[] },
  database: Database = getDatabase(),
) {
  const [message] = await database
    .select({
      accountId: messages.accountId,
      providerMessageId: messages.providerMessageId,
    })
    .from(messages)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, messages.accountId))
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  if (!message) return null;
  const labels =
    input.gmailLabelIds.length > 0
      ? await database
          .select({
            id: gmailLabels.id,
            providerLabelId: gmailLabels.providerLabelId,
          })
          .from(gmailLabels)
          .where(
            and(
              eq(gmailLabels.accountId, message.accountId),
              inArray(gmailLabels.id, input.gmailLabelIds),
            ),
          )
      : [];
  if (labels.length !== new Set(input.gmailLabelIds).size) return null;
  return { ...message, labels };
}

export async function getGmailDraftResourceForUser(
  input: { userId: string; gmailDraftId: string },
  database: Database = getDatabase(),
) {
  const [draft] = await database
    .select({
      id: gmailDrafts.id,
      accountId: gmailDrafts.accountId,
      providerDraftId: gmailDrafts.providerDraftId,
      providerThreadId: gmailDrafts.providerThreadId,
    })
    .from(gmailDrafts)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, gmailDrafts.accountId))
    .where(
      and(
        eq(gmailDrafts.id, input.gmailDraftId),
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);
  return draft ?? null;
}

export async function getAiReplyDraftForGmailSave(
  input: { userId: string; draftId: string },
  database: Database = getDatabase(),
) {
  const [draft] = await database
    .select({
      id: drafts.id,
      currentText: drafts.currentText,
      updatedAt: drafts.updatedAt,
      threadId: threads.id,
      providerThreadId: threads.providerThreadId,
      subject: threads.subject,
      accountId: connectedAccounts.id,
      accountEmail: connectedAccounts.email,
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, drafts.accountId))
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(drafts.id, input.draftId),
        eq(drafts.userId, input.userId),
        eq(drafts.status, "editing"),
        eq(connectedAccounts.status, "connected"),
        eq(gmailReplicaStates.state, "ready"),
      ),
    )
    .limit(1);
  if (!draft) return null;
  const [replyTarget] = await database
    .select({
      sender: messages.sender,
      headerLines: messages.headerLines,
    })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, draft.threadId),
        eq(messages.direction, "incoming"),
      ),
    )
    .orderBy(desc(messages.internalDate), desc(messages.id))
    .limit(1);
  return { ...draft, replyTarget: replyTarget ?? null };
}

async function insertMailboxChange(
  transaction: DatabaseTransaction,
  input: {
    userId: string;
    accountId: string;
    changeType:
      | "replica_ready"
      | "history_applied"
      | "repair_complete"
      | "drafts_changed"
      | "labels_changed";
    payload?: Record<string, unknown>;
  },
) {
  const [event] = await transaction
    .insert(mailboxChangeEvents)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      changeType: input.changeType,
      payload: input.payload ?? {},
    })
    .returning({ id: mailboxChangeEvents.id });
  return event?.id ?? null;
}

export async function replaceGmailLabelCatalog(
  input: {
    userId: string;
    accountId: string;
    labels: GmailProviderLabelInput[];
    notify?: boolean;
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const providerLabelIds = input.labels.map((label) => label.providerLabelId);
    if (providerLabelIds.length === 0) {
      await transaction
        .delete(gmailLabels)
        .where(eq(gmailLabels.accountId, input.accountId));
    } else {
      await transaction
        .delete(gmailLabels)
        .where(
          and(
            eq(gmailLabels.accountId, input.accountId),
            not(inArray(gmailLabels.providerLabelId, providerLabelIds)),
          ),
        );
    }
    for (const label of input.labels) {
      await transaction
        .insert(gmailLabels)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          ...label,
        })
        .onConflictDoUpdate({
          target: [gmailLabels.accountId, gmailLabels.providerLabelId],
          set: {
            name: label.name,
            type: label.type,
            messageListVisibility: label.messageListVisibility,
            labelListVisibility: label.labelListVisibility,
            color: label.color,
            providerMetadata: label.providerMetadata,
            updatedAt: new Date(),
          },
        });
    }
    if (input.notify) {
      await insertMailboxChange(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        changeType: "labels_changed",
        payload: { labelCount: input.labels.length },
      });
    }
  });
}

export async function replaceGmailDraftResources(
  input: {
    userId: string;
    accountId: string;
    drafts: GmailDraftResourceInput[];
    notify?: boolean;
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const providerDraftIds = input.drafts.map((draft) => draft.providerDraftId);
    if (providerDraftIds.length === 0) {
      await transaction
        .delete(gmailDrafts)
        .where(eq(gmailDrafts.accountId, input.accountId));
    } else {
      await transaction
        .delete(gmailDrafts)
        .where(
          and(
            eq(gmailDrafts.accountId, input.accountId),
            not(inArray(gmailDrafts.providerDraftId, providerDraftIds)),
          ),
        );
    }
    for (const draft of input.drafts) {
      const [message] = await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.accountId, input.accountId),
            eq(messages.providerMessageId, draft.providerMessageId),
          ),
        )
        .limit(1);
      await transaction
        .insert(gmailDrafts)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          ...draft,
          messageId: message?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [gmailDrafts.accountId, gmailDrafts.providerDraftId],
          set: {
            providerMessageId: draft.providerMessageId,
            providerThreadId: draft.providerThreadId,
            providerHistoryId: draft.providerHistoryId,
            providerMetadata: draft.providerMetadata,
            messageId: message?.id ?? null,
            updatedAt: new Date(),
          },
        });
    }
    if (input.notify) {
      await insertMailboxChange(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        changeType: "drafts_changed",
        payload: { draftCount: input.drafts.length },
      });
    }
  });
}

export async function getGmailReplicaContext(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [state] = await database
    .select({
      accountId: gmailReplicaStates.accountId,
      initialHistoryId: gmailReplicaStates.initialHistoryId,
      historyCursor: gmailReplicaStates.historyCursor,
      state: gmailReplicaStates.state,
      userId: connectedAccounts.userId,
      email: connectedAccounts.email,
    })
    .from(gmailReplicaStates)
    .innerJoin(
      connectedAccounts,
      eq(connectedAccounts.id, gmailReplicaStates.accountId),
    )
    .where(eq(gmailReplicaStates.accountId, accountId))
    .limit(1);
  return state ?? null;
}

export async function getGmailWatchContext(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [watch] = await database
    .select({
      status: gmailWatchStates.status,
      expirationAt: gmailWatchStates.expirationAt,
    })
    .from(gmailWatchStates)
    .where(eq(gmailWatchStates.accountId, accountId))
    .limit(1);
  return watch ?? null;
}

export async function setGmailReplicaState(
  input: {
    accountId: string;
    state: "pending" | "snapshotting" | "replaying" | "auditing" | "ready" | "repairing" | "failed" | "deleting";
    lastError?: string | null;
  },
  database: Database = getDatabase(),
) {
  await database
    .update(gmailReplicaStates)
    .set({
      state: input.state,
      lastError: input.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(gmailReplicaStates.accountId, input.accountId));
}

export async function saveGmailWatchState(
  input: { accountId: string; watch: GmailWatchInput; scheduleRenewal: boolean },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, input.accountId))
      .limit(1);
    if (!account) throw new Error("The Gmail account was not found for watch state.");
    await transaction
      .insert(gmailWatchStates)
      .values({ accountId: input.accountId, ...input.watch })
      .onConflictDoUpdate({
        target: gmailWatchStates.accountId,
        set: {
          ...input.watch,
          status: "active",
          lastRenewedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      });
    if (input.scheduleRenewal) {
      const renewAt = new Date(
        Math.max(input.watch.expirationAt.getTime() - 24 * 60 * 60 * 1_000, Date.now()),
      );
      await enqueueWorkflowStep(
        {
          userId: account.userId,
          accountId: input.accountId,
          stepType: "gmail.watch.renew",
          payload: { runAt: renewAt.toISOString() },
          idempotencyKey: `gmail-watch-renew:${input.accountId}:${input.watch.expirationAt.toISOString()}`,
        },
        transaction as unknown as Database,
      );
    }
  });
}

export async function ingestGmailPushEvent(
  input: {
    providerEventId: string;
    emailAddress: string;
    notificationHistoryId: string;
    subscription: string;
    publishedAt: Date | null;
    payload: Record<string, unknown>;
  },
  database: Database = getDatabase(),
): Promise<{ duplicate: boolean; accountId: string | null }> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id, userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.provider, "gmail"),
          eq(connectedAccounts.email, input.emailAddress),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .limit(1);
    const [event] = await transaction
      .insert(gmailPushEvents)
      .values({
        ...input,
        accountId: account?.id ?? null,
      })
      .onConflictDoNothing({ target: gmailPushEvents.providerEventId })
      .returning({ id: gmailPushEvents.id });
    if (!event) return { duplicate: true, accountId: account?.id ?? null };

    if (account) {
      await enqueueWorkflowStep(
        {
          userId: account.userId,
          accountId: account.id,
          stepType: "gmail.history.catchup",
          payload: { pushEventId: event.id },
          idempotencyKey: `gmail-history-push:${event.id}`,
        },
        transaction as unknown as Database,
      );
    }
    return { duplicate: false, accountId: account?.id ?? null };
  });
}

export async function enqueueGmailHistoryCatchup(
  input: { userId: string; accountId: string; reason: "manual" | "provider_write" },
  database: Database = getDatabase(),
) {
  return enqueueWorkflowStep(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "gmail.history.catchup",
      payload: { reason: input.reason },
      idempotencyKey: `gmail-history-${input.reason}:${input.accountId}:${uuidv4()}`,
    },
    database,
  );
}

export async function enqueueGmailHistoryCatchupForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<
  | { stepId: string; reason: null }
  | { stepId: null; reason: "not_found" | "replica_not_ready" }
> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({
        id: connectedAccounts.id,
        state: gmailReplicaStates.state,
      })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .limit(1);
    if (!account) return { stepId: null, reason: "not_found" };
    if (account.state !== "ready") {
      return { stepId: null, reason: "replica_not_ready" };
    }
    const stepId = await enqueueGmailHistoryCatchup(
      { userId, accountId: account.id, reason: "manual" },
      transaction as unknown as Database,
    );
    return { stepId, reason: null };
  });
}

export async function enqueueGmailReplicaAuditForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<
  | { stepId: string; reason: null }
  | { stepId: null; reason: "not_found" }
> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id, state: gmailReplicaStates.state })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .limit(1);
    if (!account) return { stepId: null, reason: "not_found" };
    const stepId = await enqueueWorkflowStep(
      {
        userId,
        accountId: account.id,
        stepType: "gmail.replica.audit",
        payload: { trigger: "manual" },
        idempotencyKey: `gmail-replica-audit:${account.id}:${uuidv4()}`,
      },
      transaction as unknown as Database,
    );
    return { stepId, reason: null };
  });
}

export async function applyGmailHistoryBatch(
  input: {
    userId: string;
    accountId: string;
    expectedCursor: string;
    nextCursor: string;
    messages: IndexedMessage[];
    deletedMessageIds: Array<{ providerMessageId: string; providerHistoryId: string | null }>;
    pushEventId?: string | null;
    stateAfterApply?: "ready" | "replaying" | "repairing";
    markStoredPushEventsProcessed?: boolean;
  },
  database: Database = getDatabase(),
): Promise<{ applied: boolean; changedThreadIds: string[]; eventId: string | null }> {
  return database.transaction(async (transaction) => {
    const [replica] = await transaction
      .select({
        initialHistoryId: gmailReplicaStates.initialHistoryId,
        historyCursor: gmailReplicaStates.historyCursor,
      })
      .from(gmailReplicaStates)
      .where(eq(gmailReplicaStates.accountId, input.accountId))
      .for("update")
      .limit(1);
    if (!replica) throw new Error("The Gmail replica state was not found.");
    const currentCursor = replica.historyCursor ?? replica.initialHistoryId;
    if (currentCursor !== input.expectedCursor) {
      return { applied: false, changedThreadIds: [], eventId: null };
    }

    const changedThreadIds = new Set<string>();
    const executor = transaction as unknown as Database;
    for (const message of input.messages) {
      const result = await upsertIndexedMessage(message, executor);
      if (result.changed) changedThreadIds.add(result.threadId);
    }
    for (const deletion of input.deletedMessageIds) {
      const result = await deleteIndexedMessage(
        {
          accountId: input.accountId,
          providerMessageId: deletion.providerMessageId,
          providerHistoryId: deletion.providerHistoryId,
        },
        executor,
      );
      if (result.changed && result.threadId) changedThreadIds.add(result.threadId);
    }
    await transaction
      .update(gmailReplicaStates)
      .set({
        historyCursor: input.nextCursor,
        state: input.stateAfterApply ?? "ready",
        lastHistoryAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
    await transaction
      .update(connectedAccounts)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(connectedAccounts.id, input.accountId));
    if (input.pushEventId) {
      await transaction
        .update(gmailPushEvents)
        .set({ status: "processed", processedAt: new Date(), updatedAt: new Date() })
        .where(eq(gmailPushEvents.id, input.pushEventId));
    }
    if (input.markStoredPushEventsProcessed) {
      await transaction
        .update(gmailPushEvents)
        .set({
          status: "processed",
          processedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(gmailPushEvents.accountId, input.accountId),
            eq(gmailPushEvents.status, "stored"),
          ),
        );
    }
    const eventId = await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "history_applied",
      payload: {
        historyCursor: input.nextCursor,
        changedThreadIds: Array.from(changedThreadIds),
      },
    });
    return {
      applied: true,
      changedThreadIds: Array.from(changedThreadIds),
      eventId,
    };
  });
}

export async function beginGmailReplicaAudit(
  input: {
    userId: string;
    accountId: string;
    trigger: "initial" | "history_expired" | "watch_renewal" | "manual";
  },
  database: Database = getDatabase(),
) {
  const [audit] = await database
    .insert(gmailReplicaAudits)
    .values(input)
    .returning({ id: gmailReplicaAudits.id });
  if (!audit) throw new Error("The Gmail replica audit could not be started.");
  return audit.id;
}

export async function completeGmailReplicaAudit(
  input: {
    auditId: string;
    providerMessageIds: string[];
    storedMessageIds: string[];
    additionalFailureCount?: number;
    details?: Record<string, unknown>;
  },
  database: Database = getDatabase(),
) {
  const providerIds = new Set(input.providerMessageIds);
  const storedIds = new Set(input.storedMessageIds);
  const missing = input.providerMessageIds.filter((id) => !storedIds.has(id));
  const extra = input.storedMessageIds.filter((id) => !providerIds.has(id));
  const complete =
    missing.length === 0 &&
    extra.length === 0 &&
    (input.additionalFailureCount ?? 0) === 0;
  const [audit] = await database
    .update(gmailReplicaAudits)
    .set({
      status: complete ? "complete" : "repairing",
      providerMessageCount: input.providerMessageIds.length,
      storedMessageCount: input.storedMessageIds.length,
      missingMessageIds: missing,
      extraMessageIds: extra,
      details: input.details ?? {},
      completedAt: complete ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(gmailReplicaAudits.id, input.auditId))
    .returning({ accountId: gmailReplicaAudits.accountId });
  return { accountId: audit?.accountId ?? null, missing, extra };
}

export async function getGmailReplicaInventory(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [
    messageRows,
    attachmentRows,
    labelRows,
    messageLabelRows,
    draftRows,
    tombstoneRows,
  ] = await Promise.all([
      database
        .select({
          id: messages.id,
          providerMessageId: messages.providerMessageId,
          rawObjectKey: messages.rawObjectKey,
          checksumSha256: messages.rawChecksumSha256,
          contentLength: messages.rawContentLength,
        })
        .from(messages)
        .where(eq(messages.accountId, accountId)),
      database
        .select({
          providerMessageId: messages.providerMessageId,
          objectKey: messageAttachments.objectKey,
          checksumSha256: messageAttachments.checksumSha256,
          contentLength: messageAttachments.contentLength,
        })
        .from(messageAttachments)
        .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
        .where(eq(messageAttachments.accountId, accountId)),
      database
        .select({ providerLabelId: gmailLabels.providerLabelId })
        .from(gmailLabels)
        .where(eq(gmailLabels.accountId, accountId)),
      database
        .select({
          messageId: gmailMessageLabels.messageId,
          providerLabelId: gmailLabels.providerLabelId,
        })
        .from(gmailMessageLabels)
        .innerJoin(messages, eq(messages.id, gmailMessageLabels.messageId))
        .innerJoin(gmailLabels, eq(gmailLabels.id, gmailMessageLabels.gmailLabelId))
        .where(eq(gmailMessageLabels.accountId, accountId)),
      database
        .select({ providerDraftId: gmailDrafts.providerDraftId })
        .from(gmailDrafts)
        .where(eq(gmailDrafts.accountId, accountId)),
      database
        .select({
          providerMessageId: gmailMessageTombstones.providerMessageId,
          objectKeys: gmailMessageTombstones.objectKeys,
        })
        .from(gmailMessageTombstones)
        .where(eq(gmailMessageTombstones.accountId, accountId)),
    ]);

  const messageLabelMemberships = new Map(
    messageRows.map((message) => [
      message.id,
      {
        providerMessageId: message.providerMessageId,
        providerLabelIds: [] as string[],
      },
    ]),
  );
  for (const membership of messageLabelRows) {
    messageLabelMemberships
      .get(membership.messageId)
      ?.providerLabelIds.push(membership.providerLabelId);
  }

  return {
    providerMessageIds: messageRows.map((message) => message.providerMessageId),
    providerLabelIds: labelRows.map((label) => label.providerLabelId),
    messageLabelMemberships: Array.from(messageLabelMemberships.values()),
    providerDraftIds: draftRows.map((draft) => draft.providerDraftId),
    objects: [
      ...messageRows.map((message) => ({
        providerMessageId: message.providerMessageId,
        key: message.rawObjectKey,
        checksumSha256: message.checksumSha256,
        contentLength: message.contentLength,
      })),
      ...attachmentRows.map((attachment) => ({
        providerMessageId: attachment.providerMessageId,
        key: attachment.objectKey,
        checksumSha256: attachment.checksumSha256,
        contentLength: attachment.contentLength,
      })),
      ...tombstoneRows.flatMap((tombstone) =>
        tombstone.objectKeys.map((key) => ({
          providerMessageId: tombstone.providerMessageId,
          key,
          checksumSha256: null,
          contentLength: null,
        })),
      ),
    ],
  };
}

export async function failGmailReplicaAudit(
  input: { auditId: string; message: string },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [audit] = await transaction
      .update(gmailReplicaAudits)
      .set({
        status: "failed",
        details: { error: input.message },
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(gmailReplicaAudits.id, input.auditId))
      .returning({ accountId: gmailReplicaAudits.accountId });
    if (!audit) return;
    await transaction
      .update(gmailReplicaStates)
      .set({ state: "failed", lastError: input.message, updatedAt: new Date() })
      .where(eq(gmailReplicaStates.accountId, audit.accountId));
  });
}

export async function markGmailReplicaReady(
  input: { accountId: string; historyCursor: string; auditId: string },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [audit] = await transaction
      .select({
        status: gmailReplicaAudits.status,
        userId: gmailReplicaAudits.userId,
      })
      .from(gmailReplicaAudits)
      .where(
        and(
          eq(gmailReplicaAudits.id, input.auditId),
          eq(gmailReplicaAudits.accountId, input.accountId),
        ),
      )
      .limit(1);
    if (!audit || audit.status !== "complete") {
      throw new Error("The Gmail replica cannot become ready before audit completion.");
    }
    await transaction
      .update(gmailReplicaStates)
      .set({
        historyCursor: input.historyCursor,
        state: "ready",
        readyAt: new Date(),
        lastHistoryAt: new Date(),
        lastAuditAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
    await insertMailboxChange(transaction, {
      userId: audit.userId,
      accountId: input.accountId,
      changeType: "replica_ready",
      payload: { historyCursor: input.historyCursor, auditId: input.auditId },
    });
    const [pendingPush] = await transaction
      .select({ id: gmailPushEvents.id })
      .from(gmailPushEvents)
      .where(
        and(
          eq(gmailPushEvents.accountId, input.accountId),
          eq(gmailPushEvents.status, "stored"),
        ),
      )
      .limit(1);
    if (pendingPush) {
      await enqueueWorkflowStep(
        {
          userId: audit.userId,
          accountId: input.accountId,
          stepType: "gmail.history.catchup",
          payload: { reason: "post_initial_reconciliation" },
          idempotencyKey: `gmail-history-post-ready:${input.accountId}:${input.auditId}`,
        },
        transaction as unknown as Database,
      );
    }
  });
}

export async function getMailboxChangeEventsForUser(
  input: { userId: string; afterEventId?: string | null; limit?: number },
  database: Database = getDatabase(),
) {
  let afterCreatedAt: Date | null = null;
  let anchoredEventId: string | null = null;
  if (input.afterEventId) {
    const [after] = await database
      .select({
        id: mailboxChangeEvents.id,
        createdAt: mailboxChangeEvents.createdAt,
      })
      .from(mailboxChangeEvents)
      .where(
        and(
          eq(mailboxChangeEvents.id, input.afterEventId),
          eq(mailboxChangeEvents.userId, input.userId),
        ),
      )
      .limit(1);
    afterCreatedAt = after?.createdAt ?? null;
    anchoredEventId = after?.id ?? null;
  }
  return database
    .select({
      id: mailboxChangeEvents.id,
      accountId: mailboxChangeEvents.accountId,
      changeType: mailboxChangeEvents.changeType,
      payload: mailboxChangeEvents.payload,
      createdAt: mailboxChangeEvents.createdAt,
    })
    .from(mailboxChangeEvents)
    .where(
      and(
        eq(mailboxChangeEvents.userId, input.userId),
        afterCreatedAt && anchoredEventId
          ? or(
              gt(mailboxChangeEvents.createdAt, afterCreatedAt),
              and(
                eq(mailboxChangeEvents.createdAt, afterCreatedAt),
                gt(mailboxChangeEvents.id, anchoredEventId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(mailboxChangeEvents.createdAt), asc(mailboxChangeEvents.id))
    .limit(input.limit ?? 100);
}

export async function getMailboxChangeEvent(
  eventId: string,
  database: Database = getDatabase(),
) {
  const [event] = await database
    .select({
      id: mailboxChangeEvents.id,
      userId: mailboxChangeEvents.userId,
      accountId: mailboxChangeEvents.accountId,
      changeType: mailboxChangeEvents.changeType,
      payload: mailboxChangeEvents.payload,
      createdAt: mailboxChangeEvents.createdAt,
    })
    .from(mailboxChangeEvents)
    .where(eq(mailboxChangeEvents.id, eventId))
    .limit(1);
  return event ?? null;
}

export async function listGmailObjectKeysForAccount(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [rawObjects, attachmentObjects, tombstones] = await Promise.all([
    database
      .select({ key: messages.rawObjectKey })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), isNotNull(messages.rawObjectKey))),
    database
      .select({ key: messageAttachments.objectKey })
      .from(messageAttachments)
      .where(
        and(
          eq(messageAttachments.accountId, accountId),
          isNotNull(messageAttachments.objectKey),
        ),
      ),
    database
      .select({ keys: gmailMessageTombstones.objectKeys })
      .from(gmailMessageTombstones)
      .where(eq(gmailMessageTombstones.accountId, accountId)),
  ]);
  return Array.from(
    new Set([
      ...rawObjects.map((entry) => entry.key),
      ...attachmentObjects.map((entry) => entry.key),
      ...tombstones.flatMap((entry) => entry.keys ?? []),
    ].filter((key): key is string => Boolean(key))),
  );
}

export async function markGmailReplicaDeleting(
  input: { userId: string; accountId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
          not(eq(connectedAccounts.status, "disconnected")),
        ),
      )
      .for("update")
      .limit(1);
    if (!account) return null;
    await transaction
      .update(gmailReplicaStates)
      .set({ state: "deleting", updatedAt: new Date() })
      .where(eq(gmailReplicaStates.accountId, input.accountId));
    await transaction
      .update(connectedAccounts)
      .set({ status: "disconnected", updatedAt: new Date() })
      .where(
        and(
          eq(connectedAccounts.id, input.accountId),
          eq(connectedAccounts.userId, input.userId),
        ),
      );
    const [cleanup] = await transaction
      .insert(gmailAccountCleanups)
      .values({ userId: input.userId, accountId: input.accountId })
      .onConflictDoUpdate({
        target: gmailAccountCleanups.accountId,
        set: {
          status: "queued",
          lastError: null,
          startedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: gmailAccountCleanups.id });
    if (!cleanup) throw new Error("The Gmail cleanup audit could not be created.");
    await enqueueWorkflowStep(
      {
        userId: input.userId,
        accountId: input.accountId,
        stepType: "gmail.account.cleanup",
        payload: { cleanupId: cleanup.id },
        idempotencyKey: `gmail-account-cleanup:${cleanup.id}`,
        maxAttempts: 10,
      },
      transaction as unknown as Database,
    );
    return cleanup.id;
  });
}

export async function markGmailReplicaDeletingForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<{ cleanupId: string; reason: null } | { cleanupId: null; reason: "not_found" }> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          not(eq(connectedAccounts.status, "disconnected")),
        ),
      )
      .limit(1);
    if (!account) return { cleanupId: null, reason: "not_found" };
    const cleanupId = await markGmailReplicaDeleting(
      { userId, accountId: account.id },
      transaction as unknown as Database,
    );
    return cleanupId
      ? { cleanupId, reason: null }
      : { cleanupId: null, reason: "not_found" };
  });
}

export async function markGmailAccountCleanupRunning(
  cleanupId: string,
  database: Database = getDatabase(),
) {
  await database
    .update(gmailAccountCleanups)
    .set({
      status: "running",
      startedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(gmailAccountCleanups.id, cleanupId));
}
