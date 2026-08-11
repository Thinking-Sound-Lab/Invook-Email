import { createHash } from "node:crypto";

import type { MailboxView } from "@invook/contracts";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
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
  memoryDeletions,
  memoryEntries,
  messageAttachments,
  messageEmbeddings,
  messages,
  profiles,
  threadLabels,
  threads,
  workflowSteps,
} from "./schema";
import type { AccountSyncState, MailboxMessage } from "./types";
import {
  createInitialMailSyncRun,
  enqueueWorkflowStep,
  getLatestMemoryBatchSubmission,
  getWorkflowStepSubmission,
} from "./workflows";
import {
  DRAFT_FEEDBACK_VERSION,
  MAIL_CLASSIFICATION_VERSION,
  MAIL_INDEX_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "./versions";

const initialSyncState: AccountSyncState = {
  mailSync: "pending",
  indexing: "pending",
  memory: "pending",
};

const mailboxPageSize = 100;

export type MailboxCursor = {
  direction: "newer" | "older";
  latestMessageAt: Date;
  threadId: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMailboxCursor(value: string): MailboxCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      direction?: unknown;
      latestMessageAt?: unknown;
      threadId?: unknown;
    };
    if (
      (decoded.direction !== "newer" && decoded.direction !== "older") ||
      typeof decoded.latestMessageAt !== "string" ||
      typeof decoded.threadId !== "string" ||
      !uuidPattern.test(decoded.threadId)
    ) {
      return null;
    }
    const latestMessageAt = new Date(decoded.latestMessageAt);
    if (!Number.isFinite(latestMessageAt.getTime())) return null;
    return {
      direction: decoded.direction,
      latestMessageAt,
      threadId: decoded.threadId,
    };
  } catch {
    return null;
  }
}

function createMailboxCursor(
  direction: MailboxCursor["direction"],
  thread: { id: string; latestMessageAt: Date | null },
): string {
  return Buffer.from(
    JSON.stringify({
      direction,
      latestMessageAt: (thread.latestMessageAt ?? new Date(0)).toISOString(),
      threadId: thread.id,
    }),
  ).toString("base64url");
}

function mailboxViewCondition(view: MailboxView) {
  switch (view) {
    case "all":
      return undefined;
    case "travel":
    case "important":
    case "pitch":
    case "newsletter":
      return sql<boolean>`exists (
        select 1
        from ${threadLabels}
        where ${threadLabels.threadId} = ${threads.id}
          and ${threadLabels.labelKey} = ${view}
          and ${threadLabels.state} = 'applied'
      )`;
    case "starred":
      return sql<boolean>`'STARRED' = any(${threads.labelIds})`;
    case "shared":
      return sql<boolean>`'SHARED' = any(${threads.labelIds})`;
    case "reminders":
      return sql<boolean>`'REMINDER' = any(${threads.labelIds})`;
    case "scheduled":
      return sql<boolean>`'SCHEDULED' = any(${threads.labelIds})`;
    case "drafts":
      return sql<boolean>`'DRAFT' = any(${threads.labelIds})`;
    case "done":
      return sql<boolean>`'DONE' = any(${threads.labelIds})`;
    case "sent":
      return sql<boolean>`'SENT' = any(${threads.labelIds})`;
    case "trash":
      return sql<boolean>`'TRASH' = any(${threads.labelIds})`;
  }
}

export type MemoryType = "preference" | "contact" | "scheduling";
export type MemorySource = "user" | "inferred" | "feedback";

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
      .select({ id: connectedAccounts.id, userId: connectedAccounts.userId })
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
          historyCursor: input.historyCursor,
          syncState: initialSyncState,
          updatedAt: new Date(),
        },
      })
      .returning({ id: connectedAccounts.id });

    if (!account) throw new Error("The Gmail connection could not be saved.");

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

    await createInitialMailSyncRun(
      {
        userId: input.userId,
        accountId: account.id,
        startingHistoryCursor: input.historyCursor,
        connectionEventId: input.acknowledgedAt.toISOString(),
      },
      transaction as unknown as Database,
    );

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

type SearchRow = {
  messageId: string;
  threadId: string;
  subject: string;
  snippet: string;
  bodyText: string;
  sender: { raw: string; email: string };
  sentAt: Date;
};

type RankedSearchRow = SearchRow & {
  fullTextMatch?: boolean;
  metadataMatch?: boolean;
  lexicalRank?: number;
  semanticSimilarity?: number;
};

export async function searchMailbox(
  input: {
    userId: string;
    query: string;
    limit?: number;
    embedding?: {
      values: number[];
      modelId: string;
      dimensions: number;
      indexVersion: number;
    };
  },
  database: Database = getDatabase(),
) {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const candidateLimit = Math.max(limit * 3, 30);
  const tsQuery = sql`websearch_to_tsquery('simple', ${query})`;
  const fullTextMatch = sql<boolean>`${messages.searchDocument} @@ ${tsQuery}`;
  const metadataMatch = sql<boolean>`${messages.metadataSearchDocument} @@ ${tsQuery}`;

  const lexicalRows = await database
    .select({
      messageId: messages.id,
      threadId: threads.id,
      subject: messages.subject,
      snippet: threads.snippet,
      bodyText: messages.bodyText,
      sender: messages.sender,
      sentAt: messages.sentAt,
      fullTextMatch,
      metadataMatch,
      lexicalRank: sql<number>`greatest(
        ts_rank_cd(${messages.searchDocument}, ${tsQuery}),
        ts_rank_cd(${messages.metadataSearchDocument}, ${tsQuery})
      )`,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.userId, input.userId),
        or(fullTextMatch, metadataMatch),
      ),
    )
    .orderBy(
      desc(sql`greatest(
        ts_rank_cd(${messages.searchDocument}, ${tsQuery}),
        ts_rank_cd(${messages.metadataSearchDocument}, ${tsQuery})
      )`),
      desc(messages.sentAt),
    )
    .limit(candidateLimit);

  const attachmentRows = await database
    .select({
      messageId: messages.id,
      threadId: threads.id,
      subject: messages.subject,
      snippet: threads.snippet,
      bodyText: messages.bodyText,
      sender: messages.sender,
      sentAt: messages.sentAt,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messageAttachments.userId, input.userId),
        sql`${messageAttachments.filenameSearchDocument} @@ ${tsQuery}`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(candidateLimit);

  const semanticRows: RankedSearchRow[] = input.embedding
    ? await database
        .select({
          messageId: messages.id,
          threadId: threads.id,
          subject: messages.subject,
          snippet: threads.snippet,
          bodyText: messages.bodyText,
          sender: messages.sender,
          sentAt: messages.sentAt,
          semanticSimilarity: sql<number>`1 - (${messageEmbeddings.embedding} <=> ${`[${input.embedding.values.join(",")}]`}::vector)`,
        })
        .from(messageEmbeddings)
        .innerJoin(messages, eq(messages.id, messageEmbeddings.messageId))
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .where(
          and(
            eq(messageEmbeddings.userId, input.userId),
            eq(messageEmbeddings.modelId, input.embedding.modelId),
            eq(messageEmbeddings.dimensions, input.embedding.dimensions),
            eq(messageEmbeddings.indexVersion, input.embedding.indexVersion),
            eq(messageEmbeddings.status, "complete"),
            isNotNull(messageEmbeddings.embedding),
          ),
        )
        .orderBy(
          asc(
            sql`${messageEmbeddings.embedding} <=> ${`[${input.embedding.values.join(",")}]`}::vector`,
          ),
        )
        .limit(candidateLimit)
    : [];

  const results = new Map<
    string,
    SearchRow & { score: number; matches: Set<string> }
  >();
  const merge = (
    row: SearchRow,
    match: "full_text" | "metadata" | "attachment" | "semantic",
    score: number,
  ) => {
    const existing = results.get(row.messageId);
    if (!existing) {
      results.set(row.messageId, {
        ...row,
        score,
        matches: new Set([match]),
      });
      return;
    }
    existing.matches.add(match);
    existing.score = Math.min(1, Math.max(existing.score, score) + 0.08);
  };

  for (const row of lexicalRows) {
    const rank = Number(row.lexicalRank);
    const normalizedRank = Number.isFinite(rank) ? rank / (rank + 1) : 0;
    if (row.fullTextMatch) merge(row, "full_text", 0.55 + 0.35 * normalizedRank);
    if (row.metadataMatch) merge(row, "metadata", 0.48 + 0.3 * normalizedRank);
  }
  for (const row of attachmentRows) merge(row, "attachment", 0.9);
  for (const row of semanticRows) {
    const similarity = Number(row.semanticSimilarity);
    const normalized = Number.isFinite(similarity)
      ? Math.max(0, Math.min(1, (similarity + 1) / 2))
      : 0;
    merge(row, "semantic", normalized * 0.82);
  }

  const ranked = [...results.values()]
    .sort(
      (left, right) =>
        right.score - left.score || right.sentAt.getTime() - left.sentAt.getTime(),
    )
    .slice(0, limit);
  const messageIds = ranked.map((row) => row.messageId);
  const attachments =
    messageIds.length > 0
      ? await database
          .select({
            id: messageAttachments.id,
            messageId: messageAttachments.messageId,
            providerAttachmentId: messageAttachments.providerAttachmentId,
            filename: messageAttachments.filename,
            mimeType: messageAttachments.mimeType,
            size: messageAttachments.size,
          })
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, messageIds))
          .orderBy(asc(messageAttachments.filename))
      : [];

  return ranked.map((row) => ({
    messageId: row.messageId,
    threadId: row.threadId,
    subject: row.subject,
    snippet: row.snippet,
    bodyPreview: row.bodyText.slice(0, 800),
    sender: row.sender,
    sentAt: row.sentAt,
    attachments: attachments.filter(
      (attachment) => attachment.messageId === row.messageId,
    ),
    matches: [...row.matches] as Array<
      "full_text" | "metadata" | "attachment" | "semantic"
    >,
    score: row.score,
  }));
}

export async function getMailboxThreadForAgent(
  userId: string,
  threadId: string,
  database: Database = getDatabase(),
) {
  const [thread] = await database
    .select({
      id: threads.id,
      subject: threads.subject,
      participants: threads.participants,
    })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);
  if (!thread) return null;

  const threadMessages = await database
    .select({
      id: messages.id,
      direction: messages.direction,
      sender: messages.sender,
      recipients: messages.recipients,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.userId, userId)))
    .orderBy(asc(messages.sentAt));
  const messageIds = threadMessages.map((message) => message.id);
  const attachmentRows =
    messageIds.length > 0
      ? await database
          .select({
            id: messageAttachments.id,
            messageId: messageAttachments.messageId,
            filename: messageAttachments.filename,
            mimeType: messageAttachments.mimeType,
            size: messageAttachments.size,
          })
          .from(messageAttachments)
          .where(
            and(
              eq(messageAttachments.userId, userId),
              inArray(messageAttachments.messageId, messageIds),
            ),
          )
          .orderBy(asc(messageAttachments.filename))
      : [];

  return {
    ...thread,
    messages: threadMessages.map((message) => ({
      ...message,
      attachments: attachmentRows.filter(
        (attachment) => attachment.messageId === message.id,
      ),
    })),
  };
}

export async function listMailboxThreadAttachments(
  userId: string,
  threadId: string,
  database: Database = getDatabase(),
) {
  return database
    .select({
      id: messageAttachments.id,
      messageId: messageAttachments.messageId,
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      size: messageAttachments.size,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messageAttachments.userId, userId),
        eq(threads.id, threadId),
        eq(threads.userId, userId),
      ),
    )
    .orderBy(asc(messageAttachments.filename));
}

export async function getMailboxWorkspace(
  userId: string,
  input: {
    cursor?: MailboxCursor | null;
    selectedThreadId?: string;
    view?: MailboxView;
  } = {},
  database: Database = getDatabase(),
) {
  const { cursor = null, selectedThreadId, view = "all" } = input;
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

  const mailboxSortTime = sql<Date>`coalesce(${threads.latestMessageAt}, to_timestamp(0))`;
  const viewCondition = mailboxViewCondition(view);
  const mailboxScope = and(
    eq(threads.userId, userId),
    eq(threads.accountId, account.id),
    viewCondition,
  );
  const cursorSortTime = cursor
    ? sql<Date>`${cursor.latestMessageAt.toISOString()}::timestamptz`
    : undefined;
  const cursorCondition = cursor && cursorSortTime
    ? or(
        cursor.direction === "newer"
          ? gt(mailboxSortTime, cursorSortTime)
          : lt(mailboxSortTime, cursorSortTime),
        and(
          eq(mailboxSortTime, cursorSortTime),
          cursor.direction === "newer"
            ? gt(threads.id, cursor.threadId)
            : lt(threads.id, cursor.threadId),
        ),
      )
    : undefined;

  const rawMailboxThreads = await database
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
    .where(and(mailboxScope, cursorCondition))
    .orderBy(
      cursor?.direction === "newer" ? asc(mailboxSortTime) : desc(mailboxSortTime),
      cursor?.direction === "newer" ? asc(threads.id) : desc(threads.id),
    )
    .limit(mailboxPageSize + 1);
  const hasExtraPage = rawMailboxThreads.length > mailboxPageSize;
  const currentPage = rawMailboxThreads.slice(0, mailboxPageSize);
  const mailboxThreads =
    cursor?.direction === "newer" ? currentPage.reverse() : currentPage;
  const hasNewerPage = Boolean(cursor) &&
    (cursor?.direction === "older" || hasExtraPage);
  const hasOlderPage = cursor?.direction === "newer" ? true : hasExtraPage;
  const [threadCount] = await database
    .select({ value: count(threads.id) })
    .from(threads)
    .where(mailboxScope);
  const firstMailboxThread = mailboxThreads[0];
  const lastMailboxThread = mailboxThreads.at(-1);
  const pagination = {
    newerCursor:
      hasNewerPage && firstMailboxThread
        ? createMailboxCursor("newer", firstMailboxThread)
        : null,
    olderCursor:
      hasOlderPage && lastMailboxThread
        ? createMailboxCursor("older", lastMailboxThread)
        : null,
    totalThreadCount: threadCount?.value ?? 0,
  };

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
  const labelRows =
    threadIds.length > 0
      ? await database
          .select({
            threadId: threadLabels.threadId,
            key: threadLabels.labelKey,
            source: threadLabels.source,
            confidence: threadLabels.confidence,
          })
          .from(threadLabels)
          .where(
            and(
              inArray(threadLabels.threadId, threadIds),
              eq(threadLabels.state, "applied"),
            ),
          )
      : [];
  const labelsByThread = new Map<string, typeof labelRows>();
  for (const label of labelRows) {
    const current = labelsByThread.get(label.threadId) ?? [];
    current.push(label);
    labelsByThread.set(label.threadId, current);
  }
  const attachLabels = <T extends { id: string }>(thread: T) => ({
    ...thread,
    invookLabels: (labelsByThread.get(thread.id) ?? []).map((label) => ({
      key: label.key,
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

  const memoryBatchSubmission = await getLatestMemoryBatchSubmission(
    account.id,
    database,
  );

  if (!selectedThread) {
    return {
      account,
      memoryBatchSubmission,
      memories: serializedMemories,
      pagination,
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

  const messageIds = threadMessages.map((message) => message.id);
  const attachmentRows =
    messageIds.length > 0
      ? await database
          .select({
            id: messageAttachments.id,
            messageId: messageAttachments.messageId,
            providerAttachmentId: messageAttachments.providerAttachmentId,
            filename: messageAttachments.filename,
            mimeType: messageAttachments.mimeType,
            size: messageAttachments.size,
          })
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, messageIds))
          .orderBy(asc(messageAttachments.filename))
      : [];
  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const attachment of attachmentRows) {
    const current = attachmentsByMessage.get(attachment.messageId) ?? [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }

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
    memoryBatchSubmission,
    memories: serializedMemories,
    pagination,
    threads: mailboxThreadsWithLabels,
    selectedThread: {
      ...attachLabels(selectedThread),
      messages: threadMessages.map((message) => ({
        ...message,
        attachments: attachmentsByMessage.get(message.id) ?? [],
      })),
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

export async function getIndexingSyncStateForUser(
  userId: string,
  database: Database = getDatabase(),
): Promise<{ accountId: string; state: AccountSyncState["indexing"] } | null> {
  const [account] = await database
    .select({
      accountId: connectedAccounts.id,
      syncState: connectedAccounts.syncState,
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

  return account
    ? { accountId: account.accountId, state: account.syncState.indexing }
    : null;
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
  await database.transaction(async (transaction) => {
    await transaction
      .update(connectedAccounts)
      .set({ syncState, updatedAt: new Date() })
      .where(eq(connectedAccounts.id, accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId, state: syncState.indexing })})`,
    );
  });
}

export async function upsertMailboxMessage(
  input: MailboxMessage,
  database: Database = getDatabase(),
): Promise<{ messageId: string; threadId: string }> {
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

    if (!storedMessage) throw new Error("The Gmail message could not be stored.");

    await transaction
      .delete(messageAttachments)
      .where(eq(messageAttachments.messageId, storedMessage.id));
    if (input.attachments.length > 0) {
      await transaction.insert(messageAttachments).values(
        input.attachments.map((attachment) => ({
          userId: input.userId,
          accountId: input.accountId,
          messageId: storedMessage.id,
          providerAttachmentId: attachment.providerAttachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
        })),
      );
    }

    await transaction
      .delete(messageEmbeddings)
      .where(
        and(
          eq(messageEmbeddings.messageId, storedMessage.id),
          ne(messageEmbeddings.contentHash, createMessageContentHash(input)),
        ),
      );

    const [messageTotal] = await transaction
      .select({ value: count(messages.id) })
      .from(messages)
      .where(eq(messages.threadId, threadId));

    await transaction
      .update(threads)
      .set({ messageCount: messageTotal?.value ?? 0, updatedAt: new Date() })
      .where(eq(threads.id, threadId));

    const [account] = await transaction
      .select({ syncState: connectedAccounts.syncState })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, input.accountId))
      .limit(1);
    if (account?.syncState.mailSync === "complete") {
      const contentHash = createMessageContentHash(input);
      await enqueueWorkflowStep(
        {
          userId: input.userId,
          accountId: input.accountId,
          stepType: "embedding.incremental",
          payload: { messageId: storedMessage.id },
          idempotencyKey: `embedding.incremental:${storedMessage.id}:${contentHash}`,
        },
        transaction as unknown as Database,
      );
    }

    return { messageId: storedMessage.id, threadId };
  });
}

export function createMessageContentHash(
  input: Pick<MailboxMessage, "subject" | "bodyText">,
): string {
  return createHash("sha256")
    .update(`${input.subject.trim()}\n${input.bodyText.trim()}`)
    .digest("hex");
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

type InvookLabelKey = "important" | "travel" | "pitch" | "newsletter";

export async function getThreadsForClassification(
  accountId: string,
  analysisVersion = MAIL_CLASSIFICATION_VERSION,
  limit = 12,
  database: Database = getDatabase(),
) {
  const candidateThreads = await database
    .select({
      id: threads.id,
      subject: threads.subject,
      participants: threads.participants,
    })
    .from(threads)
    .where(
      and(
        eq(threads.accountId, accountId),
        lt(threads.classificationVersion, analysisVersion),
      ),
    )
    .orderBy(desc(threads.latestMessageAt), desc(threads.updatedAt))
    .limit(limit);

  if (candidateThreads.length === 0) return [];

  const candidateIds = candidateThreads.map((thread) => thread.id);
  const messageRows = await database
    .select({
      threadId: messages.threadId,
      direction: messages.direction,
      sender: messages.sender,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(inArray(messages.threadId, candidateIds))
    .orderBy(desc(messages.sentAt));

  return candidateThreads.map((thread) => ({
    ...thread,
    messages: messageRows
      .filter((message) => message.threadId === thread.id)
      .slice(0, 4)
      .map((message) => ({
        direction: message.direction,
        sender: message.sender.raw || message.sender.email,
        bodyText: message.bodyText,
      })),
  }));
}

export async function saveThreadClassifications(
  input: {
    userId: string;
    accountId: string;
    modelId: string;
    analysisVersion?: number;
    threads: Array<{
      threadId: string;
      labels: Array<{ key: InvookLabelKey; confidence: number }>;
    }>;
  },
  database: Database = getDatabase(),
) {
  const analysisVersion = input.analysisVersion ?? MAIL_CLASSIFICATION_VERSION;
  await database.transaction(async (transaction) => {
    for (const classification of input.threads) {
      await transaction
        .delete(threadLabels)
        .where(
          and(
            eq(threadLabels.threadId, classification.threadId),
            eq(threadLabels.source, "ai"),
          ),
        );

      if (classification.labels.length > 0) {
        await transaction
          .insert(threadLabels)
          .values(
            classification.labels.map((label) => ({
              userId: input.userId,
              accountId: input.accountId,
              threadId: classification.threadId,
              labelKey: label.key,
              source: "ai" as const,
              state: "applied" as const,
              confidence: label.confidence.toFixed(2),
              modelId: input.modelId,
              analysisVersion,
            })),
          )
          .onConflictDoNothing({
            target: [threadLabels.threadId, threadLabels.labelKey],
          });
      }

      await transaction
        .update(threads)
        .set({
          classificationVersion: analysisVersion,
          classifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(threads.id, classification.threadId),
            eq(threads.accountId, input.accountId),
          ),
        );
    }
  });
}

export async function setUserThreadLabel(
  input: {
    userId: string;
    threadId: string;
    label: InvookLabelKey;
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

    await transaction
      .insert(threadLabels)
      .values({
        userId: input.userId,
        accountId: thread.accountId,
        threadId: thread.id,
        labelKey: input.label,
        source: "user",
        state: input.applied ? "applied" : "dismissed",
        confidence: null,
        modelId: null,
        analysisVersion: MAIL_CLASSIFICATION_VERSION,
      })
      .onConflictDoUpdate({
        target: [threadLabels.threadId, threadLabels.labelKey],
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
      metadata: { label: input.label },
    });

    const appliedLabels = await transaction
      .select({
        key: threadLabels.labelKey,
        source: threadLabels.source,
        confidence: threadLabels.confidence,
      })
      .from(threadLabels)
      .where(
        and(eq(threadLabels.threadId, thread.id), eq(threadLabels.state, "applied")),
      );

    return appliedLabels.map((label) => ({
      key: label.key,
      source: label.source,
      confidence: label.confidence === null ? null : Number(label.confidence),
    }));
  });
}

export async function getMemoryAnalysisThreads(
  accountId: string,
  database: Database = getDatabase(),
) {
  const eligibleThreadIds = database
    .select({ id: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "outgoing"),
        eq(messages.isMemoryEligible, true),
        eq(messages.excludedFromMemory, false),
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
      ownerEvidence: row.direction === "outgoing" && row.isMemoryEligible,
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
      await transaction
        .update(connectedAccounts)
        .set({
          syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{memory}', to_jsonb(${"complete"}::text), true)`,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, input.accountId));
    }

    return savedCount;
  });
}

export async function setMemorySyncStage(
  accountId: string,
  stage: AccountSyncState["memory"],
  database: Database = getDatabase(),
) {
  await database
    .update(connectedAccounts)
    .set({
      syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{memory}', to_jsonb(${stage}::text), true)`,
      updatedAt: new Date(),
    })
    .where(eq(connectedAccounts.id, accountId));
}

export async function setIndexingSyncStage(
  accountId: string,
  stage: AccountSyncState["indexing"],
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${stage}::text), true)`,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId, state: stage })})`,
    );
  });
}

export async function getEmbeddingCandidates(
  input: {
    accountId: string;
    modelId: string;
    indexVersion: number;
    limit?: number;
    messageIds?: string[];
    includeFailed?: boolean;
  },
  database: Database = getDatabase(),
) {
  if (input.messageIds?.length === 0) return [];
  const rows = await database
    .select({
      messageId: messages.id,
      userId: messages.userId,
      subject: messages.subject,
      bodyText: messages.bodyText,
      embeddingStatus: messageEmbeddings.status,
      embeddedContentHash: messageEmbeddings.contentHash,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(
      messageEmbeddings,
      and(
        eq(messageEmbeddings.messageId, messages.id),
        eq(messageEmbeddings.modelId, input.modelId),
        eq(messageEmbeddings.indexVersion, input.indexVersion),
      ),
    )
    .where(
      and(
        eq(threads.accountId, input.accountId),
        input.messageIds ? inArray(messages.id, input.messageIds) : undefined,
        or(
          isNull(messageEmbeddings.id),
          input.includeFailed === false
            ? not(
                inArray(messageEmbeddings.status, [
                  "complete",
                  "submitted",
                  "failed",
                ]),
              )
            : not(inArray(messageEmbeddings.status, ["complete", "submitted"])),
        ),
      ),
    )
    .orderBy(asc(messages.sentAt))
    .limit(input.limit ?? 50_000);

  return rows.flatMap((row) => {
    const contentHash = createMessageContentHash(row);
    if (
      row.embeddedContentHash === contentHash &&
      (row.embeddingStatus === "complete" || row.embeddingStatus === "submitted")
    ) {
      return [];
    }
    if (row.embeddingStatus === "failed" && input.includeFailed === false) {
      return [];
    }
    return [{ ...row, contentHash }];
  });
}

export async function markEmbeddingBatchSubmitted(
  input: {
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    providerBatchId: string;
    messages: Array<{ messageId: string; userId: string; contentHash: string }>;
  },
  database: Database = getDatabase(),
) {
  if (input.messages.length === 0) return;
  await database
    .insert(messageEmbeddings)
    .values(
      input.messages.map((message) => ({
        userId: message.userId,
        accountId: input.accountId,
        messageId: message.messageId,
        modelId: input.modelId,
        dimensions: input.dimensions,
        indexVersion: input.indexVersion,
        contentHash: message.contentHash,
        status: "submitted" as const,
        providerBatchId: input.providerBatchId,
      })),
    )
    .onConflictDoUpdate({
      target: [
        messageEmbeddings.messageId,
        messageEmbeddings.modelId,
        messageEmbeddings.indexVersion,
      ],
      set: {
        dimensions: input.dimensions,
        contentHash: sql`excluded.content_hash`,
        status: "submitted",
        providerBatchId: input.providerBatchId,
        lastError: null,
        updatedAt: new Date(),
      },
    });
}

export async function listSubmittedEmbeddingBatchIds(
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database
    .select({ providerBatchId: messageEmbeddings.providerBatchId })
    .from(messageEmbeddings)
    .where(
      and(
        eq(messageEmbeddings.status, "submitted"),
        isNotNull(messageEmbeddings.providerBatchId),
      ),
    )
    .groupBy(messageEmbeddings.providerBatchId);

  return rows.flatMap(({ providerBatchId }) =>
    providerBatchId ? [providerBatchId] : [],
  );
}

export async function countFailedEmbeddings(
  input: { accountId: string; modelId: string; indexVersion: number },
  database: Database = getDatabase(),
): Promise<number> {
  const [result] = await database
    .select({ value: count(messageEmbeddings.id) })
    .from(messageEmbeddings)
    .where(
      and(
        eq(messageEmbeddings.accountId, input.accountId),
        eq(messageEmbeddings.modelId, input.modelId),
        eq(messageEmbeddings.indexVersion, input.indexVersion),
        eq(messageEmbeddings.status, "failed"),
      ),
    );
  return result?.value ?? 0;
}

export async function saveMessageEmbeddings(
  input: {
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    values: Array<{
      messageId: string;
      userId: string;
      contentHash: string;
      embedding: number[];
    }>;
  },
  database: Database = getDatabase(),
): Promise<number> {
  if (input.values.length === 0) return 0;
  const currentMessages = await database
    .select({
      id: messages.id,
      subject: messages.subject,
      bodyText: messages.bodyText,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(threads.accountId, input.accountId),
        inArray(
          messages.id,
          input.values.map((value) => value.messageId),
        ),
      ),
    );
  const currentHashes = new Map(
    currentMessages.map((message) => [
      message.id,
      createMessageContentHash(message),
    ]),
  );
  const values = input.values.filter(
    (value) => currentHashes.get(value.messageId) === value.contentHash,
  );
  if (values.length === 0) return 0;

  await database
    .insert(messageEmbeddings)
    .values(
      values.map((value) => ({
        userId: value.userId,
        accountId: input.accountId,
        messageId: value.messageId,
        modelId: input.modelId,
        dimensions: input.dimensions,
        indexVersion: input.indexVersion,
        contentHash: value.contentHash,
        status: "complete" as const,
        embedding: value.embedding,
      })),
    )
    .onConflictDoUpdate({
      target: [
        messageEmbeddings.messageId,
        messageEmbeddings.modelId,
        messageEmbeddings.indexVersion,
      ],
      set: {
        dimensions: input.dimensions,
        contentHash: sql`excluded.content_hash`,
        status: "complete",
        embedding: sql`excluded.embedding`,
        providerBatchId: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });
  return values.length;
}

export async function markMessageEmbeddingsFailed(
  input: {
    modelId: string;
    indexVersion: number;
    values: Array<{ messageId: string; contentHash: string }>;
    error: string;
  },
  database: Database = getDatabase(),
) {
  for (const value of input.values) {
    await database
      .update(messageEmbeddings)
      .set({
        status: "failed",
        providerBatchId: null,
        lastError: input.error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageEmbeddings.messageId, value.messageId),
          eq(messageEmbeddings.modelId, input.modelId),
          eq(messageEmbeddings.indexVersion, input.indexVersion),
          eq(messageEmbeddings.contentHash, value.contentHash),
        ),
      );
  }
}

export async function countIncompleteEmbeddings(
  input: { accountId: string; modelId: string; indexVersion: number },
  database: Database = getDatabase(),
): Promise<number> {
  const [result] = await database
    .select({ value: count(messages.id) })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(
      messageEmbeddings,
      and(
        eq(messageEmbeddings.messageId, messages.id),
        eq(messageEmbeddings.modelId, input.modelId),
        eq(messageEmbeddings.indexVersion, input.indexVersion),
        eq(messageEmbeddings.status, "complete"),
      ),
    )
    .where(
      and(
        eq(threads.accountId, input.accountId),
        sql`${messageEmbeddings.id} is null`,
      ),
    );
  return result?.value ?? 0;
}

export async function enqueueEmbeddingBackfillContinuation(
  input: {
    userId: string;
    accountId: string;
    modelId: string;
    indexVersion: number;
    predecessorBatchId: string;
    includeFailed: boolean;
    batchAttempt: number;
    reason: "next" | "retry";
  },
  database: Database = getDatabase(),
): Promise<string | null> {
  if (input.reason === "retry") {
    const [activeRetry] = await database
      .select({ id: workflowSteps.id })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.accountId, input.accountId),
          eq(workflowSteps.stepType, "embedding.backfill"),
          inArray(workflowSteps.status, ["queued", "running"]),
          sql`${workflowSteps.input}->>'includeFailed' = 'true'`,
        ),
      )
      .orderBy(asc(workflowSteps.createdAt))
      .limit(1);
    if (activeRetry) return activeRetry.id;
  }
  return enqueueWorkflowStep(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "embedding.backfill",
      payload: {
        modelId: input.modelId,
        indexVersion: input.indexVersion,
        includeFailed: input.includeFailed,
        batchAttempt: input.batchAttempt,
      },
      idempotencyKey: `embedding.backfill.continue:${input.reason}:${input.predecessorBatchId}`,
    },
    database,
  );
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
      await enqueueWorkflowStep(
        {
          userId: input.userId,
          accountId: existing.accountId,
          stepType: "memory.feedback",
          payload: { draftId: existing.id, feedbackVersion: DRAFT_FEEDBACK_VERSION },
          idempotencyKey: `memory.feedback:${existing.accountId}:${existing.id}:${contentHash}`,
        },
        transaction as unknown as Database,
      );
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
        id: workflowSteps.id,
        userId: workflowSteps.userId,
        accountId: workflowSteps.accountId,
        stepType: workflowSteps.stepType,
      })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.status, "complete"),
          inArray(workflowSteps.stepType, [
            "memory.extract",
            "memory.batch.retry",
            "embedding.backfill",
          ]),
          sql`${workflowSteps.result}->>'provider' = ${input.provider}`,
          sql`${workflowSteps.result}->>'providerBatchId' = ${input.providerBatchId}`,
        ),
      )
      .orderBy(desc(workflowSteps.updatedAt))
      .limit(1);
    if (!submission) return null;

    const eventJobType = submission.stepType.startsWith("embedding.")
      ? "embedding.batch.event"
      : "memory.batch.event";

    await enqueueWorkflowStep(
      {
        userId: submission.userId,
        accountId: submission.accountId,
        stepType: eventJobType,
        payload: {
          submissionJobId: submission.id,
          webhookId: input.webhookId,
          eventType: input.eventType,
          provider: input.provider,
          providerBatchId: input.providerBatchId,
        },
        idempotencyKey: `${input.provider}.batch-event:${input.eventType}:${input.providerBatchId}`,
      },
      transaction as unknown as Database,
    );

    return { submissionJobId: submission.id };
  });
}

export async function getBatchSubmission(
  jobId: string,
  database: Database = getDatabase(),
) {
  return getWorkflowStepSubmission(jobId, database);
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
  return enqueueWorkflowStep(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "memory.batch.retry",
      payload: {
        parentSubmissionJobId: input.parentSubmissionJobId,
        rootSubmissionJobId: input.rootSubmissionJobId,
        batchAttempt: input.batchAttempt,
        replaceExisting: input.replaceExisting,
        manifest: input.manifest,
      },
      idempotencyKey,
    },
    database,
  );
}
