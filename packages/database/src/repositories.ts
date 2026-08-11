import { createHash } from "node:crypto";

import {
  systemLabelDefinitions,
  type LabelAnalysisState,
  type SystemLabelKey,
} from "@invook/contracts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import {
  accountSecrets,
  auditEvents,
  connectedAccounts,
  drafts,
  jobs,
  mailLabels,
  memoryDeletions,
  memoryEntries,
  memoryPendingEvidence,
  messages,
  profiles,
  threadLabels,
  threadLabelAnalyses,
  threads,
} from "./schema";
import type { AccountSyncState, ClaimedJob, IndexedMessage } from "./types";

const initialSyncState: AccountSyncState = {
  recent: "pending",
  memory: "pending",
  history: "pending",
};

export const MEMORY_SCHEMA_VERSION = 3;
export const DRAFT_FEEDBACK_VERSION = 1;

export type MemoryType = "preference" | "contact" | "scheduling";
export type MemorySource = "user" | "inferred" | "feedback";

function equalStringArrays(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function equalSender(
  left: { raw: string; email: string },
  right: { raw: string; email: string },
): boolean {
  return left.raw === right.raw && left.email === right.email;
}

function normalizeMemoryStatement(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeContactEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

export function createMemoryFingerprint(input: {
  type: MemoryType;
  contactEmail?: string | null;
  statement: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.type,
        normalizeContactEmail(input.contactEmail) ?? "",
        normalizeMemoryStatement(input.statement).toLowerCase(),
      ].join("\n"),
    )
    .digest("hex");
}

export async function checkDatabaseConnection(
  database: Database = getDatabase(),
): Promise<void> {
  await database.execute(sql`select 1`);
}

export async function getGmailConnectionForOAuth(
  providerAccountId: string,
  database: Database = getDatabase(),
) {
  const [connection] = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      tokenCiphertext: accountSecrets.tokenCiphertext,
    })
    .from(connectedAccounts)
    .leftJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .where(
      and(
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);

  return connection ?? null;
}

type SaveGmailConnectionInput = {
  userId: string;
  displayName: string | null;
  providerAccountId: string;
  email: string;
  scopes: string[];
  historyCursor: string;
  tokenCiphertext: string;
  acknowledgedAt: Date;
};

export async function saveGmailConnection(
  input: SaveGmailConnectionInput,
  database: Database = getDatabase(),
): Promise<{ id: string }> {
  return database.transaction(async (transaction) => {
    await transaction
      .insert(profiles)
      .values({
        id: input.userId,
        displayName: input.displayName,
        memoryAcknowledgedAt: input.acknowledgedAt,
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          displayName: input.displayName,
          memoryAcknowledgedAt: input.acknowledgedAt,
          updatedAt: new Date(),
        },
      });

    const [existingAccount] = await transaction
      .select({
        id: connectedAccounts.id,
        userId: connectedAccounts.userId,
        historyCursor: connectedAccounts.historyCursor,
        lastSyncedAt: connectedAccounts.lastSyncedAt,
        syncState: connectedAccounts.syncState,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.provider, "gmail"),
          eq(connectedAccounts.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);

    if (existingAccount && existingAccount.userId !== input.userId) {
      throw new Error("This Gmail account is already linked to another Invook user.");
    }

    const [account] = await transaction
      .insert(connectedAccounts)
      .values({
        userId: input.userId,
        provider: "gmail",
        providerAccountId: input.providerAccountId,
        email: input.email,
        status: "connected",
        scopes: input.scopes,
        memoryAcknowledgedAt: input.acknowledgedAt,
        historyCursor: input.historyCursor,
        syncState: initialSyncState,
      })
      .onConflictDoUpdate({
        target: [connectedAccounts.provider, connectedAccounts.providerAccountId],
        set: {
          userId: input.userId,
          email: input.email,
          status: "connected",
          scopes: input.scopes,
          memoryAcknowledgedAt: input.acknowledgedAt,
          historyCursor: existingAccount?.historyCursor ?? input.historyCursor,
          syncState: existingAccount?.syncState ?? initialSyncState,
          updatedAt: new Date(),
        },
      })
      .returning({ id: connectedAccounts.id });

    if (!account) throw new Error("The Gmail connection could not be saved.");

    if (!existingAccount) {
      await transaction
        .insert(mailLabels)
        .values(
          systemLabelDefinitions.map((definition) => ({
            userId: input.userId,
            accountId: account.id,
            name: definition.name,
            normalizedName: definition.name.toLowerCase(),
            description: definition.description,
            systemKey: definition.key,
            definitionVersion: 1,
            analysisState: "pending" as const,
          })),
        )
        .onConflictDoNothing({
          target: [mailLabels.accountId, mailLabels.systemKey],
        });
    }

    await transaction
      .insert(accountSecrets)
      .values({
        accountId: account.id,
        tokenCiphertext: input.tokenCiphertext,
        keyVersion: 1,
        refreshedAt: input.acknowledgedAt,
      })
      .onConflictDoUpdate({
        target: accountSecrets.accountId,
        set: {
          tokenCiphertext: input.tokenCiphertext,
          keyVersion: 1,
          refreshedAt: input.acknowledgedAt,
          updatedAt: new Date(),
        },
      });

    const hasCompletedInitialSync = Boolean(existingAccount?.lastSyncedAt);
    const syncJobType = hasCompletedInitialSync
      ? "gmail.incremental_sync"
      : "gmail.initial_sync";
    const startHistoryId = existingAccount?.historyCursor ?? input.historyCursor;
    const idempotencyKey = `${syncJobType}:${account.id}:${startHistoryId}`;
    await transaction
      .insert(jobs)
      .values({
        userId: input.userId,
        accountId: account.id,
        jobType: syncJobType,
        status: "queued",
        payload: { historyId: startHistoryId },
        attempts: 0,
        idempotencyKey,
      })
      .onConflictDoUpdate({
        target: jobs.idempotencyKey,
        set: {
          status: "queued",
          payload: { historyId: startHistoryId },
          attempts: 0,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: new Date(),
        },
        setWhere: ne(jobs.status, "running"),
      });

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: account.id,
      eventType: "gmail.connected",
      targetType: "connected_account",
      targetId: account.id,
      metadata: { scopes: input.scopes },
    });

    return account;
  });
}

export async function enqueueIncrementalSyncForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<
  | { jobId: string; reason: null }
  | { jobId: null; reason: "not_found" | "initial_sync_incomplete" }
> {
  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({
        id: connectedAccounts.id,
        historyCursor: connectedAccounts.historyCursor,
        lastSyncedAt: connectedAccounts.lastSyncedAt,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.status, "connected"),
        ),
      )
      .orderBy(desc(connectedAccounts.createdAt))
      .limit(1);
    if (!account) return { jobId: null, reason: "not_found" };
    if (!account.historyCursor || !account.lastSyncedAt) {
      return { jobId: null, reason: "initial_sync_incomplete" };
    }

    const idempotencyKey = `gmail.incremental_sync:${account.id}:${account.historyCursor}`;
    const [queued] = await transaction
      .insert(jobs)
      .values({
        userId,
        accountId: account.id,
        jobType: "gmail.incremental_sync",
        status: "queued",
        payload: { historyId: account.historyCursor },
        attempts: 0,
        idempotencyKey,
      })
      .onConflictDoUpdate({
        target: jobs.idempotencyKey,
        set: {
          status: "queued",
          payload: { historyId: account.historyCursor },
          attempts: 0,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
          updatedAt: new Date(),
        },
        setWhere: ne(jobs.status, "running"),
      })
      .returning({ id: jobs.id });
    if (queued) return { jobId: queued.id, reason: null };

    const [existing] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) return { jobId: existing.id, reason: null };
    throw new Error("The incremental Gmail sync job could not be queued.");
  });
}

export async function hasConnectedGmailAccount(
  userId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  const [account] = await database
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .limit(1);

  return Boolean(account);
}

export async function getMailboxSetupSummary(
  userId: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({
      id: connectedAccounts.id,
      email: connectedAccounts.email,
      status: connectedAccounts.status,
      syncState: connectedAccounts.syncState,
      lastSyncedAt: connectedAccounts.lastSyncedAt,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);

  if (!account) return null;

  const [[threadTotal], [messageTotal], [memoryTotal]] = await Promise.all([
    database
      .select({ value: count(threads.id) })
      .from(threads)
      .where(eq(threads.accountId, account.id)),
    database
      .select({ value: count(messages.id) })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(eq(threads.accountId, account.id)),
    database
      .select({ value: count(memoryEntries.id) })
      .from(memoryEntries)
      .where(eq(memoryEntries.accountId, account.id)),
  ]);

  return {
    account,
    threadCount: threadTotal?.value ?? 0,
    messageCount: messageTotal?.value ?? 0,
    memoryCount: memoryTotal?.value ?? 0,
  };
}

export async function getMailboxWorkspace(
  userId: string,
  selectedThreadId?: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({
      id: connectedAccounts.id,
      email: connectedAccounts.email,
      status: connectedAccounts.status,
      syncState: connectedAccounts.syncState,
      lastSyncedAt: connectedAccounts.lastSyncedAt,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);

  if (!account) return null;

  const mailboxThreads = await database
    .select({
      id: threads.id,
      subject: threads.subject,
      snippet: threads.snippet,
      participants: threads.participants,
      labelIds: threads.labelIds,
      latestMessageAt: threads.latestMessageAt,
      messageCount: threads.messageCount,
    })
    .from(threads)
    .where(and(eq(threads.userId, userId), eq(threads.accountId, account.id)))
    .orderBy(desc(threads.latestMessageAt), desc(threads.updatedAt))
    .limit(150);

  const memoryRows = await database
    .select({
      id: memoryEntries.id,
      type: memoryEntries.memoryType,
      contactEmail: memoryEntries.contactEmail,
      statement: memoryEntries.statement,
      source: memoryEntries.source,
      confidence: memoryEntries.confidence,
      evidenceMessageIds: memoryEntries.evidenceMessageIds,
      evidenceDraftIds: memoryEntries.evidenceDraftIds,
      createdAt: memoryEntries.createdAt,
      updatedAt: memoryEntries.updatedAt,
    })
    .from(memoryEntries)
    .where(
      and(eq(memoryEntries.userId, userId), eq(memoryEntries.accountId, account.id)),
    )
    .orderBy(
      asc(memoryEntries.memoryType),
      asc(memoryEntries.contactEmail),
      asc(memoryEntries.createdAt),
    );

  const mailLabelRows = await database
    .select({
      id: mailLabels.id,
      name: mailLabels.name,
      description: mailLabels.description,
      systemKey: mailLabels.systemKey,
      definitionVersion: mailLabels.definitionVersion,
      analysisState: mailLabels.analysisState,
      createdAt: mailLabels.createdAt,
    })
    .from(mailLabels)
    .where(
      and(eq(mailLabels.userId, userId), eq(mailLabels.accountId, account.id)),
    )
    .orderBy(asc(mailLabels.createdAt), asc(mailLabels.name));

  const [threadCountRow] = await database
    .select({ value: count(threads.id) })
    .from(threads)
    .where(and(eq(threads.userId, userId), eq(threads.accountId, account.id)));
  const analyzedCounts = await database
    .select({
      labelId: threadLabelAnalyses.labelId,
      definitionVersion: threadLabelAnalyses.definitionVersion,
      value: count(threadLabelAnalyses.id),
    })
    .from(threadLabelAnalyses)
    .where(
      and(
        eq(threadLabelAnalyses.userId, userId),
        eq(threadLabelAnalyses.accountId, account.id),
      ),
    )
    .groupBy(
      threadLabelAnalyses.labelId,
      threadLabelAnalyses.definitionVersion,
    );
  const analyzedCountByLabel = new Map(
    analyzedCounts.map((entry) => [
      `${entry.labelId}:${entry.definitionVersion}`,
      entry.value,
    ]),
  );
  const systemLabelOrder = new Map(
    systemLabelDefinitions.map((definition, index) => [definition.key, index]),
  );
  const serializedLabels = mailLabelRows
    .map((label) => ({
      id: label.id,
      name: label.name,
      description: label.description,
      systemKey: label.systemKey,
      definitionVersion: label.definitionVersion,
      analysisState: label.analysisState,
      analyzedThreadCount:
        analyzedCountByLabel.get(`${label.id}:${label.definitionVersion}`) ?? 0,
      totalThreadCount: threadCountRow?.value ?? 0,
    }))
    .sort((left, right) => {
      if (left.systemKey && right.systemKey) {
        return (
          (systemLabelOrder.get(left.systemKey) ?? 0) -
          (systemLabelOrder.get(right.systemKey) ?? 0)
        );
      }
      if (left.systemKey) return -1;
      if (right.systemKey) return 1;
      return left.name.localeCompare(right.name);
    });

  const [selectedThread] = selectedThreadId
    ? await database
        .select({
          id: threads.id,
          subject: threads.subject,
          participants: threads.participants,
          labelIds: threads.labelIds,
          latestMessageAt: threads.latestMessageAt,
          messageCount: threads.messageCount,
        })
        .from(threads)
        .where(
          and(
            eq(threads.id, selectedThreadId),
            eq(threads.userId, userId),
            eq(threads.accountId, account.id),
          ),
        )
        .limit(1)
    : [];

  const threadIds = Array.from(
    new Set([
      ...mailboxThreads.map((thread) => thread.id),
      ...(selectedThread ? [selectedThread.id] : []),
    ]),
  );
  const appliedLabelRows =
    threadIds.length > 0
      ? await database
          .select({
            threadId: threadLabels.threadId,
            labelId: threadLabels.labelId,
            name: mailLabels.name,
            systemKey: mailLabels.systemKey,
            source: threadLabels.source,
            confidence: threadLabels.confidence,
          })
          .from(threadLabels)
          .innerJoin(mailLabels, eq(mailLabels.id, threadLabels.labelId))
          .where(
            and(
              inArray(threadLabels.threadId, threadIds),
              eq(threadLabels.state, "applied"),
            ),
          )
      : [];
  const labelsByThread = new Map<string, typeof appliedLabelRows>();
  for (const label of appliedLabelRows) {
    const current = labelsByThread.get(label.threadId) ?? [];
    current.push(label);
    labelsByThread.set(label.threadId, current);
  }
  const attachLabels = <T extends { id: string }>(thread: T) => ({
    ...thread,
    invookLabels: (labelsByThread.get(thread.id) ?? []).map((label) => ({
      labelId: label.labelId,
      name: label.name,
      systemKey: label.systemKey,
      source: label.source,
      confidence: label.confidence === null ? null : Number(label.confidence),
    })),
  });
  const mailboxThreadsWithLabels = mailboxThreads.map(attachLabels);
  const serializedMemories = memoryRows.map((memory) => ({
    ...memory,
    confidence: memory.confidence === null ? null : Number(memory.confidence),
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  }));

  const [memoryBatchSubmission] = await database
    .select({ result: jobs.result })
    .from(jobs)
    .where(
      and(
        eq(jobs.accountId, account.id),
        eq(jobs.status, "complete"),
        inArray(jobs.jobType, ["memory.extract", "memory.batch.retry"]),
        sql`${jobs.result}->>'status' = 'submitted'`,
      ),
    )
    .orderBy(desc(jobs.updatedAt))
    .limit(1);

  if (!selectedThread) {
    return {
      account,
      memoryBatchSubmission: memoryBatchSubmission?.result ?? null,
      memories: serializedMemories,
      labels: serializedLabels,
      threads: mailboxThreadsWithLabels,
      selectedThread: null,
    };
  }

  const threadMessages = await database
    .select({
      id: messages.id,
      direction: messages.direction,
      sender: messages.sender,
      recipients: messages.recipients,
      labelIds: messages.labelIds,
      subject: messages.subject,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.threadId, selectedThread.id)))
    .orderBy(asc(messages.sentAt));

  const [threadDraft] = await database
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      status: drafts.status,
      generatedText: drafts.generatedText,
      currentText: drafts.currentText,
      usedMemoryIds: drafts.usedMemoryIds,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, userId),
        eq(drafts.threadId, selectedThread.id),
        eq(drafts.status, "editing"),
        isNotNull(drafts.generatedText),
      ),
    )
    .orderBy(desc(drafts.updatedAt))
    .limit(1);

  return {
    account,
    memoryBatchSubmission: memoryBatchSubmission?.result ?? null,
    memories: serializedMemories,
    labels: serializedLabels,
    threads: mailboxThreadsWithLabels,
    selectedThread: {
      ...attachLabels(selectedThread),
      messages: threadMessages,
      draft:
        threadDraft && threadDraft.generatedText
          ? {
              ...threadDraft,
              generatedText: threadDraft.generatedText,
              updatedAt: threadDraft.updatedAt.toISOString(),
            }
          : null,
    },
  };
}

export async function claimNextJob(
  workerId: string,
  jobTypes: string[],
  database: Database = getDatabase(),
): Promise<ClaimedJob | null> {
  if (jobTypes.length === 0) return null;
  return database.transaction(async (transaction) => {
    const [candidate] = await transaction
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          inArray(jobs.status, ["queued", "retry"]),
          lt(jobs.attempts, jobs.maxAttempts),
          inArray(jobs.jobType, jobTypes),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) return null;

    const [job] = await transaction
      .update(jobs)
      .set({
        status: "running",
        lockedAt: new Date(),
        lockedBy: workerId,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, candidate.id))
      .returning({
        id: jobs.id,
        userId: jobs.userId,
        accountId: jobs.accountId,
        jobType: jobs.jobType,
        payload: jobs.payload,
        attempts: jobs.attempts,
        maxAttempts: jobs.maxAttempts,
      });

    return job ?? null;
  });
}

export async function getWorkerAccount(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      email: connectedAccounts.email,
      historyCursor: connectedAccounts.historyCursor,
      syncState: connectedAccounts.syncState,
      tokenCiphertext: accountSecrets.tokenCiphertext,
    })
    .from(connectedAccounts)
    .innerJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .where(eq(connectedAccounts.id, accountId))
    .limit(1);

  return account ?? null;
}

export async function updateStoredCredential(
  accountId: string,
  tokenCiphertext: string,
  database: Database = getDatabase(),
) {
  await database
    .update(accountSecrets)
    .set({ tokenCiphertext, refreshedAt: new Date(), updatedAt: new Date() })
    .where(eq(accountSecrets.accountId, accountId));
}

export async function setAccountSyncState(
  accountId: string,
  syncState: AccountSyncState,
  database: Database = getDatabase(),
) {
  await database
    .update(connectedAccounts)
    .set({ syncState, updatedAt: new Date() })
    .where(eq(connectedAccounts.id, accountId));
}

export async function upsertIndexedMessage(
  input: IndexedMessage,
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [existingThread] = await transaction
      .select({ id: threads.id, latestMessageAt: threads.latestMessageAt })
      .from(threads)
      .where(
        and(
          eq(threads.accountId, input.accountId),
          eq(threads.providerThreadId, input.providerThreadId),
        ),
      )
      .limit(1);

    let threadId = existingThread?.id;
    if (!threadId) {
      const [insertedThread] = await transaction
        .insert(threads)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          providerThreadId: input.providerThreadId,
          subject: input.subject,
          snippet: input.snippet,
          participants: input.participants,
          labelIds: input.labelIds,
          latestMessageAt: input.sentAt,
        })
        .onConflictDoNothing({
          target: [threads.accountId, threads.providerThreadId],
        })
        .returning({ id: threads.id });

      threadId = insertedThread?.id;
      if (!threadId) {
        const [concurrentThread] = await transaction
          .select({ id: threads.id })
          .from(threads)
          .where(
            and(
              eq(threads.accountId, input.accountId),
              eq(threads.providerThreadId, input.providerThreadId),
            ),
          )
          .limit(1);
        threadId = concurrentThread?.id;
      }
    } else if (
      !existingThread.latestMessageAt ||
      input.sentAt.getTime() > existingThread.latestMessageAt.getTime()
    ) {
      await transaction
        .update(threads)
        .set({
          subject: input.subject,
          snippet: input.snippet,
          participants: input.participants,
          labelIds: input.labelIds,
          latestMessageAt: input.sentAt,
          updatedAt: new Date(),
        })
        .where(eq(threads.id, threadId));
    }

    if (!threadId) throw new Error("The Gmail thread could not be stored.");

    const [existingMessage] = await transaction
      .select({
        id: messages.id,
        direction: messages.direction,
        sender: messages.sender,
        recipients: messages.recipients,
        labelIds: messages.labelIds,
        subject: messages.subject,
        bodyText: messages.bodyText,
        sentAt: messages.sentAt,
        isMemoryEligible: messages.isMemoryEligible,
      })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.providerMessageId, input.providerMessageId),
        ),
      )
      .limit(1);
    const changed =
      !existingMessage ||
      existingMessage.direction !== input.direction ||
      !equalSender(existingMessage.sender, input.sender) ||
      !equalStringArrays(existingMessage.recipients, input.recipients) ||
      !equalStringArrays(existingMessage.labelIds, input.labelIds) ||
      existingMessage.subject !== input.subject ||
      existingMessage.bodyText !== input.bodyText ||
      existingMessage.sentAt.getTime() !== input.sentAt.getTime() ||
      existingMessage.isMemoryEligible !== input.isMemoryEligible;

    let messageId = existingMessage?.id;
    if (changed) {
      const [storedMessage] = await transaction
        .insert(messages)
        .values({
          userId: input.userId,
          threadId,
          providerMessageId: input.providerMessageId,
          direction: input.direction,
          sender: input.sender,
          recipients: input.recipients,
          labelIds: input.labelIds,
          subject: input.subject,
          bodyText: input.bodyText,
          sentAt: input.sentAt,
          isMemoryEligible: input.isMemoryEligible,
        })
        .onConflictDoUpdate({
          target: [messages.threadId, messages.providerMessageId],
          set: {
            direction: input.direction,
            sender: input.sender,
            recipients: input.recipients,
            labelIds: input.labelIds,
            subject: input.subject,
            bodyText: input.bodyText,
            sentAt: input.sentAt,
            isMemoryEligible: input.isMemoryEligible,
            updatedAt: new Date(),
          },
        })
        .returning({ id: messages.id });
      messageId = storedMessage?.id;
      if (!messageId) throw new Error("The Gmail message could not be stored.");

      await transaction
        .delete(threadLabelAnalyses)
        .where(eq(threadLabelAnalyses.threadId, threadId));
      await transaction
        .delete(threadLabels)
        .where(
          and(eq(threadLabels.threadId, threadId), eq(threadLabels.source, "ai")),
        );
      await transaction
        .update(mailLabels)
        .set({ analysisState: "pending", updatedAt: new Date() })
        .where(eq(mailLabels.accountId, input.accountId));

      if (input.ingestionMode === "incremental") {
        await transaction
          .delete(memoryPendingEvidence)
          .where(eq(memoryPendingEvidence.messageId, messageId));
        if (input.direction === "outgoing" && input.isMemoryEligible) {
          const contactEmails = Array.from(
            new Set(input.memoryContactEmails.map(normalizeContactEmail).filter(Boolean)),
          ) as string[];
          await transaction
            .insert(memoryPendingEvidence)
            .values([
              {
                userId: input.userId,
                accountId: input.accountId,
                threadId,
                messageId,
                scope: "global" as const,
                contactEmail: "",
                schemaVersion: MEMORY_SCHEMA_VERSION,
              },
              ...contactEmails.map((contactEmail) => ({
                userId: input.userId,
                accountId: input.accountId,
                threadId,
                messageId,
                scope: "contact" as const,
                contactEmail,
                schemaVersion: MEMORY_SCHEMA_VERSION,
              })),
            ])
            .onConflictDoNothing({
              target: [
                memoryPendingEvidence.messageId,
                memoryPendingEvidence.scope,
                memoryPendingEvidence.contactEmail,
              ],
            });
        }
      }
    }

    if (changed) {
      const [messageTotal] = await transaction
        .select({ value: count(messages.id) })
        .from(messages)
        .where(eq(messages.threadId, threadId));

      await transaction
        .update(threads)
        .set({ messageCount: messageTotal?.value ?? 0, updatedAt: new Date() })
        .where(eq(threads.id, threadId));
    }

    return { threadId, changed };
  });
}

export async function countMemoryEligibleMessages(
  accountId: string,
  database: Database = getDatabase(),
): Promise<number> {
  const [total] = await database
    .select({ value: count(messages.id) })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(threads.accountId, accountId),
        eq(messages.direction, "outgoing"),
        eq(messages.isMemoryEligible, true),
        eq(messages.excludedFromMemory, false),
      ),
    );

  return total?.value ?? 0;
}

export class LabelConflictError extends Error {
  constructor(message = "A label with this name already exists.") {
    super(message);
    this.name = "LabelConflictError";
  }
}

function normalizeLabelName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505",
  );
}

export async function createUserLabel(
  input: { userId: string; name: string; description: string },
  database: Database = getDatabase(),
) {
  try {
    return await database.transaction(async (transaction) => {
      const [account] = await transaction
        .select({
          id: connectedAccounts.id,
          syncState: connectedAccounts.syncState,
          historyCursor: connectedAccounts.historyCursor,
        })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.userId, input.userId),
            eq(connectedAccounts.status, "connected"),
          ),
        )
        .orderBy(desc(connectedAccounts.createdAt))
        .limit(1);
      if (!account) return null;

      const normalizedName = normalizeLabelName(input.name);
      const [existing] = await transaction
        .select({ id: mailLabels.id })
        .from(mailLabels)
        .where(
          and(
            eq(mailLabels.accountId, account.id),
            eq(mailLabels.normalizedName, normalizedName),
          ),
        )
        .limit(1);
      if (existing) throw new LabelConflictError();

      const [label] = await transaction
        .insert(mailLabels)
        .values({
          userId: input.userId,
          accountId: account.id,
          name: input.name.trim().replace(/\s+/g, " "),
          normalizedName,
          description: input.description.trim().replace(/\s+/g, " "),
          systemKey: null,
          definitionVersion: 1,
          analysisState: "pending",
        })
        .returning();
      if (!label) throw new Error("The label could not be created.");

      if (account.syncState.recent === "complete" && account.historyCursor) {
        await transaction
          .insert(jobs)
          .values({
            userId: input.userId,
            accountId: account.id,
            jobType: "label.backfill.submit",
            status: "queued",
            payload: { labelId: label.id, definitionVersion: 1 },
            attempts: 0,
            idempotencyKey: `label.backfill.submit:${label.id}:1:${account.historyCursor}`,
          })
          .onConflictDoNothing({ target: jobs.idempotencyKey });
      }

      await transaction.insert(auditEvents).values({
        userId: input.userId,
        accountId: account.id,
        eventType: "label.created",
        targetType: "label",
        targetId: label.id,
        metadata: { name: label.name },
      });

      const [threadTotal] = await transaction
        .select({ value: count(threads.id) })
        .from(threads)
        .where(eq(threads.accountId, account.id));
      return {
        id: label.id,
        name: label.name,
        description: label.description,
        systemKey: label.systemKey,
        definitionVersion: label.definitionVersion,
        analysisState: label.analysisState,
        analyzedThreadCount: 0,
        totalThreadCount: threadTotal?.value ?? 0,
      };
    });
  } catch (error) {
    if (error instanceof LabelConflictError || isUniqueViolation(error)) {
      throw new LabelConflictError();
    }
    throw error;
  }
}

export async function deleteUserLabel(
  input: { userId: string; labelId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [label] = await transaction
      .select({
        id: mailLabels.id,
        accountId: mailLabels.accountId,
        name: mailLabels.name,
        systemKey: mailLabels.systemKey,
      })
      .from(mailLabels)
      .where(
        and(eq(mailLabels.id, input.labelId), eq(mailLabels.userId, input.userId)),
      )
      .limit(1);
    if (!label) return false;

    await transaction.delete(mailLabels).where(eq(mailLabels.id, label.id));
    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: label.accountId,
      eventType: "label.deleted",
      targetType: "label",
      targetId: label.id,
      metadata: { name: label.name, systemKey: label.systemKey },
    });
    return true;
  });
}

export async function getLabelForAnalysis(
  accountId: string,
  labelId: string,
  database: Database = getDatabase(),
) {
  const [label] = await database
    .select({
      id: mailLabels.id,
      userId: mailLabels.userId,
      accountId: mailLabels.accountId,
      name: mailLabels.name,
      description: mailLabels.description,
      definitionVersion: mailLabels.definitionVersion,
      analysisState: mailLabels.analysisState,
    })
    .from(mailLabels)
    .where(and(eq(mailLabels.id, labelId), eq(mailLabels.accountId, accountId)))
    .limit(1);
  return label ?? null;
}

async function loadLabelAnalysisThreads(
  accountId: string,
  threadIds: string[],
  database: Database,
) {
  if (threadIds.length === 0) return [];
  const threadRows = await database
    .select({
      id: threads.id,
      subject: threads.subject,
      participants: threads.participants,
      latestMessageAt: threads.latestMessageAt,
      updatedAt: threads.updatedAt,
    })
    .from(threads)
    .where(and(eq(threads.accountId, accountId), inArray(threads.id, threadIds)))
    .orderBy(desc(threads.latestMessageAt), desc(threads.updatedAt));
  const rankedMessages = database
    .select({
      threadId: messages.threadId,
      direction: messages.direction,
      sender: messages.sender,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
      rank: sql<number>`row_number() over (partition by ${messages.threadId} order by ${messages.sentAt} desc)`.as(
        "message_rank",
      ),
    })
    .from(messages)
    .where(inArray(messages.threadId, threadIds))
    .as("ranked_label_messages");
  const messageRows = await database
    .select({
      threadId: rankedMessages.threadId,
      direction: rankedMessages.direction,
      sender: rankedMessages.sender,
      bodyText: rankedMessages.bodyText,
      sentAt: rankedMessages.sentAt,
    })
    .from(rankedMessages)
    .where(lte(rankedMessages.rank, 3))
    .orderBy(desc(rankedMessages.sentAt));

  const messagesByThread = new Map<string, typeof messageRows>();
  for (const message of messageRows) {
    const grouped = messagesByThread.get(message.threadId) ?? [];
    grouped.push(message);
    messagesByThread.set(message.threadId, grouped);
  }

  return threadRows.map((thread) => ({
    id: thread.id,
    subject: thread.subject,
    participants: thread.participants,
    messages: (messagesByThread.get(thread.id) ?? [])
      .slice(0, 3)
      .map((message) => ({
        direction: message.direction,
        sender: message.sender.raw || message.sender.email,
        bodyText: message.bodyText,
      })),
  }));
}

export async function getThreadsForLabelBackfill(
  input: { accountId: string; labelId: string; definitionVersion: number },
  database: Database = getDatabase(),
) {
  const candidateRows = await database
    .select({ id: threads.id })
    .from(threads)
    .leftJoin(
      threadLabelAnalyses,
      and(
        eq(threadLabelAnalyses.threadId, threads.id),
        eq(threadLabelAnalyses.labelId, input.labelId),
      ),
    )
    .where(
      and(
        eq(threads.accountId, input.accountId),
        or(
          isNull(threadLabelAnalyses.id),
          ne(threadLabelAnalyses.definitionVersion, input.definitionVersion),
        ),
      ),
    )
    .orderBy(desc(threads.latestMessageAt), desc(threads.updatedAt))
    .limit(50_000);
  return loadLabelAnalysisThreads(
    input.accountId,
    candidateRows.map((thread) => thread.id),
    database,
  );
}

export function getThreadsForLabelRetry(
  accountId: string,
  threadIds: string[],
  database: Database = getDatabase(),
) {
  return loadLabelAnalysisThreads(accountId, threadIds, database);
}

export async function setLabelAnalysisState(
  input: {
    accountId: string;
    labelId: string;
    definitionVersion: number;
    state: LabelAnalysisState;
  },
  database: Database = getDatabase(),
) {
  await database
    .update(mailLabels)
    .set({
      analysisState: input.state,
      lastAnalyzedAt: input.state === "complete" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailLabels.id, input.labelId),
        eq(mailLabels.accountId, input.accountId),
        eq(mailLabels.definitionVersion, input.definitionVersion),
      ),
    );
}

export async function saveLabelBatchResults(
  input: {
    userId: string;
    accountId: string;
    labelId: string;
    definitionVersion: number;
    modelId: string;
    results: Array<{
      threadId: string;
      matched: boolean;
      confidence: number;
    }>;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [label] = await transaction
      .select({ id: mailLabels.id })
      .from(mailLabels)
      .where(
        and(
          eq(mailLabels.id, input.labelId),
          eq(mailLabels.accountId, input.accountId),
          eq(mailLabels.definitionVersion, input.definitionVersion),
        ),
      )
      .for("update")
      .limit(1);
    if (!label) return false;

    for (let offset = 0; offset < input.results.length; offset += 500) {
      const results = input.results.slice(offset, offset + 500);
      const threadIds = results.map((result) => result.threadId);
      await transaction
        .delete(threadLabels)
        .where(
          and(
            inArray(threadLabels.threadId, threadIds),
            eq(threadLabels.labelId, input.labelId),
            eq(threadLabels.source, "ai"),
          ),
        );

      const matches = results.filter((result) => result.matched);
      if (matches.length > 0) {
        await transaction
          .insert(threadLabels)
          .values(matches.map((result) => ({
            userId: input.userId,
            accountId: input.accountId,
            threadId: result.threadId,
            labelId: input.labelId,
            source: "ai" as const,
            state: "applied" as const,
            confidence: result.confidence.toFixed(2),
            modelId: input.modelId,
            analysisVersion: input.definitionVersion,
          })))
          .onConflictDoNothing({
            target: [threadLabels.threadId, threadLabels.labelId],
          });
      }

      await transaction
        .insert(threadLabelAnalyses)
        .values(results.map((result) => ({
          userId: input.userId,
          accountId: input.accountId,
          threadId: result.threadId,
          labelId: input.labelId,
          definitionVersion: input.definitionVersion,
          modelId: input.modelId,
          analyzedAt: new Date(),
        })))
        .onConflictDoUpdate({
          target: [threadLabelAnalyses.threadId, threadLabelAnalyses.labelId],
          set: {
            definitionVersion: input.definitionVersion,
            modelId: input.modelId,
            analyzedAt: new Date(),
          },
        });
    }
    return true;
  });
}

export async function setUserThreadLabel(
  input: {
    userId: string;
    threadId: string;
    labelId: string;
    applied: boolean;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({ id: threads.id, accountId: threads.accountId })
      .from(threads)
      .where(and(eq(threads.id, input.threadId), eq(threads.userId, input.userId)))
      .limit(1);
    if (!thread) return null;

    const [label] = await transaction
      .select({
        id: mailLabels.id,
        name: mailLabels.name,
        definitionVersion: mailLabels.definitionVersion,
      })
      .from(mailLabels)
      .where(
        and(
          eq(mailLabels.id, input.labelId),
          eq(mailLabels.userId, input.userId),
          eq(mailLabels.accountId, thread.accountId),
        ),
      )
      .limit(1);
    if (!label) return null;

    await transaction
      .insert(threadLabels)
      .values({
        userId: input.userId,
        accountId: thread.accountId,
        threadId: thread.id,
        labelId: label.id,
        source: "user",
        state: input.applied ? "applied" : "dismissed",
        confidence: null,
        modelId: null,
        analysisVersion: label.definitionVersion,
      })
      .onConflictDoUpdate({
        target: [threadLabels.threadId, threadLabels.labelId],
        set: {
          source: "user",
          state: input.applied ? "applied" : "dismissed",
          confidence: null,
          modelId: null,
          updatedAt: new Date(),
        },
      });

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: thread.accountId,
      eventType: input.applied ? "thread.label_applied" : "thread.label_dismissed",
      targetType: "thread",
      targetId: thread.id,
      metadata: { labelId: label.id, labelName: label.name },
    });

    const appliedLabels = await transaction
      .select({
        labelId: threadLabels.labelId,
        name: mailLabels.name,
        systemKey: mailLabels.systemKey,
        source: threadLabels.source,
        confidence: threadLabels.confidence,
      })
      .from(threadLabels)
      .innerJoin(mailLabels, eq(mailLabels.id, threadLabels.labelId))
      .where(
        and(eq(threadLabels.threadId, thread.id), eq(threadLabels.state, "applied")),
      );

    return appliedLabels.map((label) => ({
      labelId: label.labelId,
      name: label.name,
      systemKey: label.systemKey,
      source: label.source,
      confidence: label.confidence === null ? null : Number(label.confidence),
    }));
  });
}

export async function getMemoryAnalysisThreads(
  accountId: string,
  evidenceMessageIds?: string[],
  database: Database = getDatabase(),
) {
  if (evidenceMessageIds && evidenceMessageIds.length === 0) return [];
  const evidenceIdSet = evidenceMessageIds
    ? new Set(evidenceMessageIds)
    : null;
  const eligibleThreadIds = database
    .select({ id: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "outgoing"),
        eq(messages.isMemoryEligible, true),
        eq(messages.excludedFromMemory, false),
        ...(evidenceMessageIds
          ? [inArray(messages.id, evidenceMessageIds)]
          : []),
      ),
    )
    .groupBy(messages.threadId);

  const rows = await database
    .select({
      threadId: messages.threadId,
      threadSubject: threads.subject,
      id: messages.id,
      direction: messages.direction,
      sender: messages.sender,
      recipients: messages.recipients,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
      isMemoryEligible: messages.isMemoryEligible,
    })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(
      and(
        eq(threads.accountId, accountId),
        inArray(threads.id, eligibleThreadIds),
        eq(messages.excludedFromMemory, false),
        or(
          eq(messages.direction, "incoming"),
          and(
            eq(messages.direction, "outgoing"),
            eq(messages.isMemoryEligible, true),
            ...(evidenceMessageIds
              ? [inArray(messages.id, evidenceMessageIds)]
              : []),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.threadId), asc(messages.sentAt));

  const grouped = new Map<
    string,
    {
      id: string;
      subject: string;
      messages: Array<{
        id: string;
        direction: "incoming" | "outgoing";
        sender: { raw: string; email: string };
        recipients: string[];
        bodyText: string;
        sentAt: Date;
        ownerEvidence: boolean;
      }>;
    }
  >();

  for (const row of rows) {
    const thread = grouped.get(row.threadId) ?? {
      id: row.threadId,
      subject: row.threadSubject,
      messages: [],
    };
    thread.messages.push({
      id: row.id,
      direction: row.direction,
      sender: row.sender,
      recipients: row.recipients,
      bodyText: row.bodyText,
      sentAt: row.sentAt,
      ownerEvidence:
        row.direction === "outgoing" &&
        row.isMemoryEligible &&
        (!evidenceIdSet || evidenceIdSet.has(row.id)),
    });
    grouped.set(row.threadId, thread);
  }

  return Array.from(grouped.values());
}

export async function getUserAuthoredMemories(
  accountId: string,
  database: Database = getDatabase(),
) {
  return database
    .select({
      id: memoryEntries.id,
      type: memoryEntries.memoryType,
      contactEmail: memoryEntries.contactEmail,
      statement: memoryEntries.statement,
    })
    .from(memoryEntries)
    .where(
      and(eq(memoryEntries.accountId, accountId), eq(memoryEntries.source, "user")),
    )
    .orderBy(asc(memoryEntries.createdAt));
}

export async function getMemoriesForUser(
  userId: string,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({ id: connectedAccounts.id, syncState: connectedAccounts.syncState })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        not(eq(connectedAccounts.status, "disconnected")),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);
  if (!account) return null;

  const entries = await database
    .select({
      id: memoryEntries.id,
      type: memoryEntries.memoryType,
      contactEmail: memoryEntries.contactEmail,
      statement: memoryEntries.statement,
      source: memoryEntries.source,
      confidence: memoryEntries.confidence,
      evidenceMessageIds: memoryEntries.evidenceMessageIds,
      evidenceDraftIds: memoryEntries.evidenceDraftIds,
      createdAt: memoryEntries.createdAt,
      updatedAt: memoryEntries.updatedAt,
    })
    .from(memoryEntries)
    .where(
      and(eq(memoryEntries.userId, userId), eq(memoryEntries.accountId, account.id)),
    )
    .orderBy(
      asc(memoryEntries.memoryType),
      asc(memoryEntries.contactEmail),
      asc(memoryEntries.createdAt),
    );

  return { account, entries };
}

type MemoryEntryInput = {
  type: MemoryType;
  contactEmail?: string | null;
  statement: string;
};

function memoryValues(input: MemoryEntryInput) {
  const statement = normalizeMemoryStatement(input.statement);
  const contactEmail =
    input.type === "contact" ? normalizeContactEmail(input.contactEmail) : null;
  return {
    type: input.type,
    contactEmail,
    statement,
    fingerprint: createMemoryFingerprint({
      type: input.type,
      contactEmail,
      statement,
    }),
  };
}

export class MemoryConflictError extends Error {
  constructor() {
    super("An identical memory already exists.");
    this.name = "MemoryConflictError";
  }
}

export async function createUserMemory(
  input: { userId: string } & MemoryEntryInput,
  database: Database = getDatabase(),
) {
  const value = memoryValues(input);
  if (input.type === "contact" && !value.contactEmail) {
    throw new Error("A contact memory requires an email address.");
  }

  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, input.userId),
          not(eq(connectedAccounts.status, "disconnected")),
        ),
      )
      .orderBy(desc(connectedAccounts.createdAt))
      .limit(1);
    if (!account) return null;

    await transaction
      .delete(memoryDeletions)
      .where(
        and(
          eq(memoryDeletions.accountId, account.id),
          eq(memoryDeletions.fingerprint, value.fingerprint),
        ),
      );

    const [memory] = await transaction
      .insert(memoryEntries)
      .values({
        userId: input.userId,
        accountId: account.id,
        memoryType: value.type,
        contactEmail: value.contactEmail,
        statement: value.statement,
        source: "user",
        confidence: null,
        fingerprint: value.fingerprint,
        schemaVersion: MEMORY_SCHEMA_VERSION,
      })
      .onConflictDoUpdate({
        target: [memoryEntries.accountId, memoryEntries.fingerprint],
        set: {
          memoryType: value.type,
          contactEmail: value.contactEmail,
          statement: value.statement,
          source: "user",
          confidence: null,
          evidenceMessageIds: [],
          evidenceDraftIds: [],
          modelId: null,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!memory) throw new Error("The memory could not be saved.");

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: account.id,
      eventType: "memory.created",
      targetType: "memory",
      targetId: memory.id,
      metadata: { type: value.type, contactEmail: value.contactEmail },
    });
    return memory;
  });
}

export async function updateUserMemory(
  input: { userId: string; memoryId: string } & MemoryEntryInput,
  database: Database = getDatabase(),
) {
  const value = memoryValues(input);
  if (input.type === "contact" && !value.contactEmail) {
    throw new Error("A contact memory requires an email address.");
  }

  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: memoryEntries.id,
        userId: memoryEntries.userId,
        accountId: memoryEntries.accountId,
        memoryType: memoryEntries.memoryType,
        contactEmail: memoryEntries.contactEmail,
        fingerprint: memoryEntries.fingerprint,
      })
      .from(memoryEntries)
      .where(
        and(eq(memoryEntries.id, input.memoryId), eq(memoryEntries.userId, input.userId)),
      )
      .limit(1);
    if (!existing) return null;

    const [duplicate] = await transaction
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.accountId, existing.accountId),
          eq(memoryEntries.fingerprint, value.fingerprint),
          ne(memoryEntries.id, existing.id),
        ),
      )
      .limit(1);
    if (duplicate) throw new MemoryConflictError();

    await transaction
      .delete(memoryDeletions)
      .where(
        and(
          eq(memoryDeletions.accountId, existing.accountId),
          eq(memoryDeletions.fingerprint, value.fingerprint),
        ),
      );

    if (existing.fingerprint !== value.fingerprint) {
      await transaction
        .insert(memoryDeletions)
        .values({
          userId: existing.userId,
          accountId: existing.accountId,
          memoryType: existing.memoryType,
          contactEmail: existing.contactEmail,
          fingerprint: existing.fingerprint,
        })
        .onConflictDoUpdate({
          target: [memoryDeletions.accountId, memoryDeletions.fingerprint],
          set: {
            contactEmail: existing.contactEmail,
            deletedAt: new Date(),
          },
        });
    }

    const [memory] = await transaction
      .update(memoryEntries)
      .set({
        memoryType: value.type,
        contactEmail: value.contactEmail,
        statement: value.statement,
        source: "user",
        confidence: null,
        evidenceMessageIds: [],
        evidenceDraftIds: [],
        modelId: null,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        fingerprint: value.fingerprint,
        updatedAt: new Date(),
      })
      .where(eq(memoryEntries.id, existing.id))
      .returning();
    if (!memory) return null;

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: existing.accountId,
      eventType: "memory.updated",
      targetType: "memory",
      targetId: memory.id,
      metadata: { type: value.type, contactEmail: value.contactEmail },
    });
    return memory;
  });
}

export async function deleteUserMemory(
  input: { userId: string; memoryId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [memory] = await transaction
      .select()
      .from(memoryEntries)
      .where(
        and(eq(memoryEntries.id, input.memoryId), eq(memoryEntries.userId, input.userId)),
      )
      .limit(1);
    if (!memory) return false;

    await transaction
      .insert(memoryDeletions)
      .values({
        userId: memory.userId,
        accountId: memory.accountId,
        memoryType: memory.memoryType,
        contactEmail: memory.contactEmail,
        fingerprint: memory.fingerprint,
      })
      .onConflictDoUpdate({
        target: [memoryDeletions.accountId, memoryDeletions.fingerprint],
        set: {
          contactEmail: memory.contactEmail,
          deletedAt: new Date(),
        },
      });
    await transaction.delete(memoryEntries).where(eq(memoryEntries.id, memory.id));
    await transaction.insert(auditEvents).values({
      userId: memory.userId,
      accountId: memory.accountId,
      eventType: "memory.deleted",
      targetType: "memory",
      targetId: memory.id,
      metadata: { type: memory.memoryType, contactEmail: memory.contactEmail },
    });
    return true;
  });
}

export async function saveExtractedMemories(
  input: {
    userId: string;
    accountId: string;
    source: Exclude<MemorySource, "user">;
    modelId: string | null;
    replaceExisting?: boolean;
    markComplete?: boolean;
    memories: Array<
      MemoryEntryInput & {
        confidence: number;
        evidenceMessageIds?: string[];
        evidenceDraftIds?: string[];
      }
    >;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const deletedRows = await transaction
      .select({ fingerprint: memoryDeletions.fingerprint })
      .from(memoryDeletions)
      .where(eq(memoryDeletions.accountId, input.accountId));
    const deletedFingerprints = new Set(deletedRows.map((row) => row.fingerprint));

    if (input.replaceExisting !== false) {
      await transaction
        .delete(memoryEntries)
        .where(
          and(
            eq(memoryEntries.accountId, input.accountId),
            eq(memoryEntries.source, input.source),
          ),
        );
    }

    let savedCount = 0;
    for (const candidate of input.memories) {
      const value = memoryValues(candidate);
      if (
        (candidate.type === "contact" && !value.contactEmail) ||
        deletedFingerprints.has(value.fingerprint)
      ) {
        continue;
      }

      const [existing] = await transaction
        .select({
          id: memoryEntries.id,
          source: memoryEntries.source,
          confidence: memoryEntries.confidence,
          evidenceMessageIds: memoryEntries.evidenceMessageIds,
          evidenceDraftIds: memoryEntries.evidenceDraftIds,
        })
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.accountId, input.accountId),
            eq(memoryEntries.fingerprint, value.fingerprint),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.source === input.source) {
          await transaction
            .update(memoryEntries)
            .set({
              confidence: Math.max(
                Number(existing.confidence ?? 0),
                candidate.confidence,
              ).toFixed(2),
              evidenceMessageIds: Array.from(
                new Set([
                  ...existing.evidenceMessageIds,
                  ...(candidate.evidenceMessageIds ?? []),
                ]),
              ),
              evidenceDraftIds: Array.from(
                new Set([
                  ...existing.evidenceDraftIds,
                  ...(candidate.evidenceDraftIds ?? []),
                ]),
              ),
              modelId: input.modelId,
              schemaVersion: MEMORY_SCHEMA_VERSION,
              updatedAt: new Date(),
            })
            .where(eq(memoryEntries.id, existing.id));
          savedCount += 1;
        }
        continue;
      }

      const inserted = await transaction
        .insert(memoryEntries)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          memoryType: value.type,
          contactEmail: value.contactEmail,
          statement: value.statement,
          source: input.source,
          confidence: candidate.confidence.toFixed(2),
          evidenceMessageIds: Array.from(new Set(candidate.evidenceMessageIds ?? [])),
          evidenceDraftIds: Array.from(new Set(candidate.evidenceDraftIds ?? [])),
          modelId: input.modelId,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          fingerprint: value.fingerprint,
        })
        .onConflictDoNothing({
          target: [memoryEntries.accountId, memoryEntries.fingerprint],
        })
        .returning({ id: memoryEntries.id });
      savedCount += inserted.length;
    }

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: input.accountId,
      eventType: `memory.${input.source}_refreshed`,
      targetType: "connected_account",
      targetId: input.accountId,
      metadata: { savedCount, schemaVersion: MEMORY_SCHEMA_VERSION },
    });

    if (input.source === "inferred" && input.markComplete !== false) {
      const [account] = await transaction
        .select({ syncState: connectedAccounts.syncState })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, input.accountId))
        .limit(1);
      if (account) {
        await transaction
          .update(connectedAccounts)
          .set({
            syncState: { ...account.syncState, memory: "complete" },
            updatedAt: new Date(),
          })
          .where(eq(connectedAccounts.id, input.accountId));
      }
    }

    return savedCount;
  });
}

export async function setMemorySyncStage(
  accountId: string,
  stage: AccountSyncState["memory"],
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({ syncState: connectedAccounts.syncState })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, accountId))
    .limit(1);
  if (!account) return;

  await database
    .update(connectedAccounts)
    .set({ syncState: { ...account.syncState, memory: stage }, updatedAt: new Date() })
    .where(eq(connectedAccounts.id, accountId));
}

export async function getReplyDraftContext(
  userId: string,
  threadId: string,
  database: Database = getDatabase(),
) {
  const [thread] = await database
    .select({
      id: threads.id,
      accountId: threads.accountId,
      subject: threads.subject,
      participants: threads.participants,
      accountEmail: connectedAccounts.email,
    })
    .from(threads)
    .innerJoin(connectedAccounts, eq(connectedAccounts.id, threads.accountId))
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);
  if (!thread) return null;

  const [threadMessages, memories] = await Promise.all([
    database
      .select({
        id: messages.id,
        direction: messages.direction,
        sender: messages.sender,
        recipients: messages.recipients,
        bodyText: messages.bodyText,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.threadId, thread.id)))
      .orderBy(asc(messages.sentAt)),
    database
      .select({
        id: memoryEntries.id,
        type: memoryEntries.memoryType,
        contactEmail: memoryEntries.contactEmail,
        statement: memoryEntries.statement,
        source: memoryEntries.source,
      })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.userId, userId),
          eq(memoryEntries.accountId, thread.accountId),
        ),
      )
      .orderBy(asc(memoryEntries.createdAt)),
  ]);

  return { ...thread, messages: threadMessages, memories };
}

export async function saveGeneratedDraft(
  input: {
    userId: string;
    accountId: string;
    threadId: string;
    text: string;
    usedMemoryIds: string[];
    modelId: string;
    schedulingRelevant: boolean;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.id, input.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .limit(1);
    if (!thread) return null;

    await transaction
      .update(drafts)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(
        and(
          eq(drafts.userId, input.userId),
          eq(drafts.threadId, input.threadId),
          eq(drafts.status, "editing"),
        ),
      );

    const [draft] = await transaction
      .insert(drafts)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        threadId: input.threadId,
        status: "editing",
        generatedText: input.text,
        currentText: input.text,
        usedMemoryIds: Array.from(new Set(input.usedMemoryIds)),
        generationMetadata: {
          modelId: input.modelId,
          schedulingRelevant: input.schedulingRelevant,
        },
        generatedAt: new Date(),
      })
      .returning();
    return draft ?? null;
  });
}

export async function saveDraftEdit(
  input: { userId: string; draftId: string; currentText: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: drafts.id,
        accountId: drafts.accountId,
        threadId: drafts.threadId,
        generatedText: drafts.generatedText,
      })
      .from(drafts)
      .where(
        and(
          eq(drafts.id, input.draftId),
          eq(drafts.userId, input.userId),
          eq(drafts.status, "editing"),
        ),
      )
      .limit(1);
    if (!existing?.generatedText) return null;

    const [draft] = await transaction
      .update(drafts)
      .set({
        currentText: input.currentText,
        feedbackVersion: 0,
        lastFeedbackAt: null,
        editSignals: [],
        updatedAt: new Date(),
      })
      .where(eq(drafts.id, existing.id))
      .returning();
    if (!draft) return null;

    if (normalizeMemoryStatement(existing.generatedText) !== normalizeMemoryStatement(input.currentText)) {
      const contentHash = createHash("sha256").update(input.currentText).digest("hex");
      await transaction
        .insert(jobs)
        .values({
          userId: input.userId,
          accountId: existing.accountId,
          jobType: "memory.feedback",
          status: "queued",
          payload: { draftId: existing.id, feedbackVersion: DRAFT_FEEDBACK_VERSION },
          attempts: 0,
          idempotencyKey: `memory.feedback:${existing.accountId}:${existing.id}:${contentHash}`,
        })
        .onConflictDoNothing({ target: jobs.idempotencyKey });
    }

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: existing.accountId,
      eventType: "draft.edited",
      targetType: "draft",
      targetId: existing.id,
      metadata: { changed: existing.generatedText !== input.currentText },
    });
    return draft;
  });
}

export async function getDraftFeedbackSamples(
  accountId: string,
  _feedbackVersion = DRAFT_FEEDBACK_VERSION,
  limit = 60,
  database: Database = getDatabase(),
) {
  return database
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      subject: threads.subject,
      participants: threads.participants,
      generatedText: drafts.generatedText,
      editedText: drafts.currentText,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(
      and(
        eq(drafts.accountId, accountId),
        isNotNull(drafts.generatedText),
        ne(drafts.currentText, sql`coalesce(${drafts.generatedText}, '')`),
      ),
    )
    .orderBy(desc(drafts.updatedAt))
    .limit(limit);
}

export async function markDraftFeedbackAnalyzed(
  input: {
    draftIds: string[];
    signalsByDraft: Map<string, Array<{ type: MemoryType; statement: string }>>;
    feedbackVersion?: number;
  },
  database: Database = getDatabase(),
) {
  const feedbackVersion = input.feedbackVersion ?? DRAFT_FEEDBACK_VERSION;
  await database.transaction(async (transaction) => {
    for (const draftId of input.draftIds) {
      await transaction
        .update(drafts)
        .set({
          feedbackVersion,
          lastFeedbackAt: new Date(),
          editSignals: input.signalsByDraft.get(draftId) ?? [],
          updatedAt: new Date(),
        })
        .where(eq(drafts.id, draftId));
    }
  });
}

export async function completeInitialSync(
  accountId: string,
  historyCursor: string,
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [account] = await transaction
      .update(connectedAccounts)
      .set({
        historyCursor,
        lastSyncedAt: new Date(),
        syncState: { recent: "complete", memory: "pending", history: "complete" },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, accountId))
      .returning({ userId: connectedAccounts.userId });
    if (!account) throw new Error("The indexed Gmail account was not found.");

    const accountLabels = await transaction
      .select({ id: mailLabels.id, definitionVersion: mailLabels.definitionVersion })
      .from(mailLabels)
      .where(eq(mailLabels.accountId, accountId));
    const analysisJobs = [
      ...accountLabels.map((label) => ({
        jobType: "label.backfill.submit",
        idempotencyKey: `label.backfill.submit:${label.id}:${label.definitionVersion}:${historyCursor}`,
        payload: {
          labelId: label.id,
          definitionVersion: label.definitionVersion,
        },
      })),
      {
        jobType: "memory.extract",
        idempotencyKey: `memory.extract:${accountId}:${MEMORY_SCHEMA_VERSION}:${historyCursor}`,
        payload: { schemaVersion: MEMORY_SCHEMA_VERSION },
      },
    ];
    await transaction
      .insert(jobs)
      .values(
        analysisJobs.map((job) => ({
          userId: account.userId,
          accountId,
          jobType: job.jobType,
          status: "queued" as const,
          payload: job.payload,
          attempts: 0,
          idempotencyKey: job.idempotencyKey,
        })),
      )
      .onConflictDoNothing({ target: jobs.idempotencyKey });
  });
}

type PendingMemoryEvidence = {
  messageId: string;
  scope: "global" | "contact";
  contactEmail: string;
};

function incrementalMemoryJobs(input: {
  userId: string;
  accountId: string;
  pendingEvidence: PendingMemoryEvidence[];
}) {
  const evidenceByScope = new Map<string, PendingMemoryEvidence[]>();
  for (const evidence of input.pendingEvidence) {
    const key = `${evidence.scope}:${evidence.contactEmail}`;
    const grouped = evidenceByScope.get(key) ?? [];
    grouped.push(evidence);
    evidenceByScope.set(key, grouped);
  }

  return Array.from(evidenceByScope.values()).flatMap((evidence) => {
    if (evidence.length < 3) return [];
    const first = evidence[0];
    if (!first) return [];
    const evidenceMessageIds = evidence.map((entry) => entry.messageId);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          scope: first.scope,
          contactEmail: first.contactEmail,
          evidenceMessageIds,
        }),
      )
      .digest("hex");
    return [{
      userId: input.userId,
      accountId: input.accountId,
      jobType: "memory.incremental",
      status: "queued" as const,
      payload: {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        mode: first.scope,
        contactEmail: first.scope === "contact" ? first.contactEmail : null,
        evidenceMessageIds,
      },
      attempts: 0,
      idempotencyKey: `memory.incremental:${input.accountId}:${digest}`,
    }];
  });
}

export async function completeIncrementalSync(
  input: {
    accountId: string;
    historyCursor: string;
    changedThreadIds: string[];
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ userId: connectedAccounts.userId, syncState: connectedAccounts.syncState })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, input.accountId))
      .for("update")
      .limit(1);
    if (!account) throw new Error("The indexed Gmail account was not found.");

    await transaction
      .update(connectedAccounts)
      .set({
        historyCursor: input.historyCursor,
        lastSyncedAt: new Date(),
        syncState: {
          ...account.syncState,
          recent: "complete",
          history: "complete",
        },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, input.accountId));

    const changedThreadIds = Array.from(new Set(input.changedThreadIds));
    const pendingLabels = await transaction
      .select({ id: mailLabels.id, definitionVersion: mailLabels.definitionVersion })
      .from(mailLabels)
      .where(
        and(
          eq(mailLabels.accountId, input.accountId),
          ne(mailLabels.analysisState, "complete"),
        ),
      );
    if (pendingLabels.length > 0) {
      await transaction
        .insert(jobs)
        .values(
          pendingLabels.map((label) => ({
            userId: account.userId,
            accountId: input.accountId,
            jobType: "label.backfill.submit",
            status: "queued" as const,
            payload: {
              labelId: label.id,
              definitionVersion: label.definitionVersion,
            },
            attempts: 0,
            idempotencyKey: `label.backfill.submit:${label.id}:${label.definitionVersion}:${input.historyCursor}`,
          })),
        )
        .onConflictDoNothing({ target: jobs.idempotencyKey });
    }

    const pendingEvidence = await transaction
      .select({
        messageId: memoryPendingEvidence.messageId,
        scope: memoryPendingEvidence.scope,
        contactEmail: memoryPendingEvidence.contactEmail,
      })
      .from(memoryPendingEvidence)
      .where(
        and(
          eq(memoryPendingEvidence.accountId, input.accountId),
          eq(memoryPendingEvidence.schemaVersion, MEMORY_SCHEMA_VERSION),
        ),
      )
      .orderBy(asc(memoryPendingEvidence.createdAt), asc(memoryPendingEvidence.id));
    const memoryJobs =
      account.syncState.memory === "complete"
        ? incrementalMemoryJobs({
            userId: account.userId,
            accountId: input.accountId,
            pendingEvidence,
          })
        : [];
    if (memoryJobs.length > 0) {
      await transaction
        .insert(jobs)
        .values(memoryJobs)
        .onConflictDoNothing({ target: jobs.idempotencyKey });
    }

    await transaction.insert(auditEvents).values({
      userId: account.userId,
      accountId: input.accountId,
      eventType: "gmail.incremental_sync_completed",
      targetType: "connected_account",
      targetId: input.accountId,
      metadata: {
        historyCursor: input.historyCursor,
        changedThreadCount: changedThreadIds.length,
      },
    });
  });
}

export async function clearPendingMemoryEvidence(
  input: {
    accountId: string;
    mode: "global" | "contact";
    contactEmail: string | null;
    messageIds: string[];
  },
  database: Database = getDatabase(),
) {
  if (input.messageIds.length === 0) return;
  await database
    .delete(memoryPendingEvidence)
    .where(
      and(
        eq(memoryPendingEvidence.accountId, input.accountId),
        eq(memoryPendingEvidence.scope, input.mode),
        eq(memoryPendingEvidence.contactEmail, input.contactEmail ?? ""),
        inArray(memoryPendingEvidence.messageId, input.messageIds),
      ),
    );
}

export async function enqueueAnalysisJobsForIndexedAccounts(
  database: Database = getDatabase(),
): Promise<number> {
  const indexedAccounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      historyCursor: connectedAccounts.historyCursor,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, "connected"));

  const indexedAccountIds = indexedAccounts.map((account) => account.id);
  const accountLabels =
    indexedAccountIds.length > 0
      ? await database
          .select({
            id: mailLabels.id,
            accountId: mailLabels.accountId,
            definitionVersion: mailLabels.definitionVersion,
            analysisState: mailLabels.analysisState,
          })
          .from(mailLabels)
          .where(inArray(mailLabels.accountId, indexedAccountIds))
      : [];

  const analysisJobs = indexedAccounts.flatMap((account) => {
    if (account.syncState.recent !== "complete" || !account.historyCursor) return [];
    return [
      ...accountLabels
        .filter(
          (label) =>
            label.accountId === account.id && label.analysisState !== "complete",
        )
        .map((label) => ({
          userId: account.userId,
          accountId: account.id,
          jobType: "label.backfill.submit",
          status: "queued" as const,
          payload: {
            labelId: label.id,
            definitionVersion: label.definitionVersion,
          },
          attempts: 0,
          idempotencyKey: `label.backfill.submit:${label.id}:${label.definitionVersion}:${account.historyCursor}`,
        })),
      ...(account.syncState.memory === "complete"
        ? []
        : [{
            userId: account.userId,
            accountId: account.id,
            jobType: "memory.extract",
            status: "queued" as const,
            payload: { schemaVersion: MEMORY_SCHEMA_VERSION },
            attempts: 0,
            idempotencyKey: `memory.extract:${account.id}:${MEMORY_SCHEMA_VERSION}:${account.historyCursor}`,
          }]),
    ];
  });
  const memoryReadyAccountIds = indexedAccounts
    .filter((account) => account.syncState.memory === "complete")
    .map((account) => account.id);
  const pendingEvidence =
    memoryReadyAccountIds.length > 0
      ? await database
          .select({
            accountId: memoryPendingEvidence.accountId,
            messageId: memoryPendingEvidence.messageId,
            scope: memoryPendingEvidence.scope,
            contactEmail: memoryPendingEvidence.contactEmail,
          })
          .from(memoryPendingEvidence)
          .where(
            and(
              inArray(memoryPendingEvidence.accountId, memoryReadyAccountIds),
              eq(memoryPendingEvidence.schemaVersion, MEMORY_SCHEMA_VERSION),
            ),
          )
          .orderBy(
            asc(memoryPendingEvidence.accountId),
            asc(memoryPendingEvidence.createdAt),
            asc(memoryPendingEvidence.id),
          )
      : [];
  const pendingEvidenceByAccount = new Map<
    string,
    PendingMemoryEvidence[]
  >();
  for (const evidence of pendingEvidence) {
    const grouped = pendingEvidenceByAccount.get(evidence.accountId) ?? [];
    grouped.push(evidence);
    pendingEvidenceByAccount.set(evidence.accountId, grouped);
  }
  const incrementalJobs = indexedAccounts.flatMap((account) =>
    account.syncState.memory === "complete"
      ? incrementalMemoryJobs({
          userId: account.userId,
          accountId: account.id,
          pendingEvidence: pendingEvidenceByAccount.get(account.id) ?? [],
        })
      : [],
  );
  const values = [...analysisJobs, ...incrementalJobs];
  if (values.length === 0) return 0;

  const inserted = await database
    .insert(jobs)
    .values(values)
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });
  return inserted.length;
}

export async function completeJob(
  jobId: string,
  result: Record<string, unknown> = {},
  database: Database = getDatabase(),
) {
  await database
    .update(jobs)
    .set({
      status: "complete",
      result: { ...result, completedAt: new Date().toISOString() },
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

export async function enqueueBatchEvent(
  input: {
    provider: "openai" | "azure-openai";
    webhookId: string;
    eventType: string;
    providerBatchId: string;
  },
  database: Database = getDatabase(),
): Promise<{ submissionJobId: string } | null> {
  return database.transaction(async (transaction) => {
    const [submission] = await transaction
      .select({
        id: jobs.id,
        userId: jobs.userId,
        accountId: jobs.accountId,
        jobType: jobs.jobType,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "complete"),
          inArray(jobs.jobType, [
            "memory.extract",
            "memory.incremental",
            "memory.batch.retry",
            "label.backfill.submit",
            "label.batch.retry",
          ]),
          sql`${jobs.result}->>'provider' = ${input.provider}`,
          sql`${jobs.result}->>'providerBatchId' = ${input.providerBatchId}`,
        ),
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(1);
    if (!submission) return null;

    await transaction
      .insert(jobs)
      .values({
        userId: submission.userId,
        accountId: submission.accountId,
        jobType: submission.jobType.startsWith("label.")
          ? "label.batch.event"
          : "memory.batch.event",
        status: "queued",
        payload: {
          submissionJobId: submission.id,
          webhookId: input.webhookId,
          eventType: input.eventType,
          provider: input.provider,
          providerBatchId: input.providerBatchId,
        },
        attempts: 0,
        idempotencyKey: `${input.provider}.webhook:${input.webhookId}`,
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey });

    return { submissionJobId: submission.id };
  });
}

export async function getMemoryBatchSubmission(
  jobId: string,
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .select({
      id: jobs.id,
      userId: jobs.userId,
      accountId: jobs.accountId,
      jobType: jobs.jobType,
      result: jobs.result,
      maxAttempts: jobs.maxAttempts,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "complete"),
        inArray(jobs.jobType, [
          "memory.extract",
          "memory.incremental",
          "memory.batch.retry",
        ]),
      ),
    )
    .limit(1);

  return submission ?? null;
}

export async function getLabelBatchSubmission(
  jobId: string,
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .select({
      id: jobs.id,
      userId: jobs.userId,
      accountId: jobs.accountId,
      jobType: jobs.jobType,
      result: jobs.result,
      maxAttempts: jobs.maxAttempts,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "complete"),
        inArray(jobs.jobType, ["label.backfill.submit", "label.batch.retry"]),
      ),
    )
    .limit(1);

  return submission ?? null;
}

export async function enqueueMemoryBatchRetry(
  input: {
    userId: string;
    accountId: string;
    parentSubmissionJobId: string;
    rootSubmissionJobId: string;
    batchAttempt: number;
    replaceExisting: boolean;
    manifest: Array<{
      key: string;
      mode: "global" | "contact";
      contactEmail: string | null;
      messageIds: string[];
    }>;
  },
  database: Database = getDatabase(),
) {
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        input.manifest.map((entry) => ({
          key: entry.key,
          messageIds: entry.messageIds,
        })),
      ),
    )
    .digest("hex");

  const idempotencyKey = `memory.batch.retry:${input.parentSubmissionJobId}:${manifestHash}`;
  const inserted = await database
    .insert(jobs)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      jobType: "memory.batch.retry",
      status: "queued",
      payload: {
        parentSubmissionJobId: input.parentSubmissionJobId,
        rootSubmissionJobId: input.rootSubmissionJobId,
        batchAttempt: input.batchAttempt,
        replaceExisting: input.replaceExisting,
        manifest: input.manifest,
      },
      attempts: 0,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });

  if (inserted[0]) return inserted[0].id;
  const [existing] = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing?.id ?? null;
}

export async function enqueueLabelBatchRetry(
  input: {
    userId: string;
    accountId: string;
    labelId: string;
    definitionVersion: number;
    parentSubmissionJobId: string;
    rootSubmissionJobId: string;
    batchAttempt: number;
    continueBackfill: boolean;
    manifest: Array<{
      key: string;
      labelId: string;
      definitionVersion: number;
      threadId: string;
    }>;
  },
  database: Database = getDatabase(),
) {
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        input.manifest.map((entry) => ({
          key: entry.key,
          threadId: entry.threadId,
        })),
      ),
    )
    .digest("hex");
  const idempotencyKey = `label.batch.retry:${input.parentSubmissionJobId}:${manifestHash}`;
  const inserted = await database
    .insert(jobs)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      jobType: "label.batch.retry",
      status: "queued",
      payload: {
        labelId: input.labelId,
        definitionVersion: input.definitionVersion,
        parentSubmissionJobId: input.parentSubmissionJobId,
        rootSubmissionJobId: input.rootSubmissionJobId,
        batchAttempt: input.batchAttempt,
        continueBackfill: input.continueBackfill,
        manifest: input.manifest,
      },
      attempts: 0,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });

  if (inserted[0]) return inserted[0].id;
  const [existing] = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing?.id ?? null;
}

export async function enqueueLabelBackfillContinuation(
  input: {
    userId: string;
    accountId: string;
    labelId: string;
    definitionVersion: number;
    parentSubmissionJobId: string;
  },
  database: Database = getDatabase(),
) {
  const idempotencyKey = `label.backfill.continue:${input.parentSubmissionJobId}`;
  const inserted = await database
    .insert(jobs)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      jobType: "label.backfill.submit",
      status: "queued",
      payload: {
        labelId: input.labelId,
        definitionVersion: input.definitionVersion,
      },
      attempts: 0,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });

  if (inserted[0]) return inserted[0].id;
  const [existing] = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing?.id ?? null;
}

export async function deferJobWithoutAttempt(
  input: { jobId: string; message: string },
  database: Database = getDatabase(),
) {
  await database
    .update(jobs)
    .set({
      status: "queued",
      attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
      lastError: input.message,
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, input.jobId));
}

export async function failAnalysisJob(
  input: { job: ClaimedJob; message: string },
  database: Database = getDatabase(),
) {
  const terminal = input.job.attempts >= input.job.maxAttempts;
  await database.transaction(async (transaction) => {
    await transaction
      .update(jobs)
      .set({
        status: terminal ? "failed" : "retry",
        lastError: input.message,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, input.job.id));

    if (
      terminal &&
      ["memory.extract", "memory.batch.retry", "memory.batch.event"].includes(
        input.job.jobType,
      ) &&
      input.job.accountId
    ) {
      const [account] = await transaction
        .select({ syncState: connectedAccounts.syncState })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, input.job.accountId))
        .limit(1);
      if (account) {
        await transaction
          .update(connectedAccounts)
          .set({
            syncState: { ...account.syncState, memory: "failed" },
            updatedAt: new Date(),
          })
          .where(eq(connectedAccounts.id, input.job.accountId));
      }
    }

    if (terminal && input.job.jobType.startsWith("label.") && input.job.accountId) {
      let labelId = input.job.payload.labelId;
      let definitionVersion = input.job.payload.definitionVersion;
      if (input.job.jobType === "label.batch.event") {
        const submissionJobId = input.job.payload.submissionJobId;
        if (typeof submissionJobId === "string") {
          const [submission] = await transaction
            .select({ result: jobs.result })
            .from(jobs)
            .where(eq(jobs.id, submissionJobId))
            .limit(1);
          if (submission?.result && typeof submission.result === "object") {
            labelId = submission.result.labelId;
            definitionVersion = submission.result.definitionVersion;
          }
        }
      }
      if (typeof labelId === "string" && typeof definitionVersion === "number") {
        await transaction
          .update(mailLabels)
          .set({ analysisState: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(mailLabels.id, labelId),
              eq(mailLabels.accountId, input.job.accountId),
              eq(mailLabels.definitionVersion, definitionVersion),
            ),
          );
      }
    }
  });
}

export async function failJobAndAccount(input: {
  job: ClaimedJob;
  message: string;
  reconnectRequired: boolean;
}, database: Database = getDatabase()) {
  const accountId = input.job.accountId;

  await database.transaction(async (transaction) => {
    await transaction
      .update(jobs)
      .set({
        status: input.job.attempts < input.job.maxAttempts ? "retry" : "failed",
        lastError: input.message,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, input.job.id));

    if (accountId) {
      const [account] = await transaction
        .select({ syncState: connectedAccounts.syncState })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, accountId))
        .limit(1);
      await transaction
        .update(connectedAccounts)
        .set({
          status: input.reconnectRequired ? "reconnect_required" : "connected",
          syncState:
            input.job.jobType === "gmail.incremental_sync" && account
              ? { ...account.syncState, recent: "failed", history: "failed" }
              : { recent: "failed", memory: "pending", history: "pending" },
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, accountId));
    }
  });
}
