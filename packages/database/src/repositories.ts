import { createHash } from "node:crypto";

import {
  MAIL_EMBEDDING_DIMENSIONS,
  systemLabelDefinitions,
  type LabelAnalysisState,
  type MailboxView,
  type SystemLabelKey,
} from "@invook/contracts";
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
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { validate as validateUuid } from "uuid";

import { getDatabase, type Database } from "./client";
import {
  accountSecrets,
  auditEvents,
  connectedAccounts,
  drafts,
  embeddingBatchSubmissions,
  gmailDrafts,
  gmailLabels,
  gmailMessageLabels,
  gmailMessageTombstones,
  gmailPushEvents,
  gmailReplicaAudits,
  gmailReplicaStates,
  gmailWatchStates,
  jobs,
  mailLabels,
  mailboxChangeEvents,
  memoryDeletions,
  memoryEntries,
  memoryPendingEvidence,
  messageAttachments,
  messageEmbeddings,
  messages,
  profiles,
  threadLabels,
  threadLabelAnalyses,
  threads,
  workflowSteps,
} from "./schema";
import type {
  AccountSyncState,
  ClaimedJob,
  IndexedMessage,
  MailboxMessage,
} from "./types";
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

export class GmailLabelCatalogMismatchError extends Error {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly missingProviderLabelIds: string[];

  constructor(input: {
    accountId: string;
    providerMessageId: string;
    missingProviderLabelIds: string[];
  }) {
    super(
      `Gmail label catalog is missing membership for message ${input.providerMessageId}.`,
    );
    this.name = "GmailLabelCatalogMismatchError";
    this.accountId = input.accountId;
    this.providerMessageId = input.providerMessageId;
    this.missingProviderLabelIds = input.missingProviderLabelIds;
  }
}

export type MailboxCursor = {
  direction: "newer" | "older";
  latestMessageAt: Date;
  threadId: string;
};

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
      !validateUuid(decoded.threadId)
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
  if (view.startsWith("label:")) {
    const labelId = view.slice(6);
    return sql<boolean>`exists (
      select 1
      from ${threadLabels}
      where ${threadLabels.threadId} = ${threads.id}
        and ${threadLabels.labelId} = ${labelId}::uuid
        and ${threadLabels.state} = 'applied'
    )`;
  }
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
        inner join ${mailLabels} on ${mailLabels.id} = ${threadLabels.labelId}
        where ${threadLabels.threadId} = ${threads.id}
          and ${mailLabels.systemKey} = ${view}
          and ${threadLabels.state} = 'applied'
      )`;
    case "starred":
    case "drafts":
    case "sent":
    case "trash": {
      const providerLabelId = view.toUpperCase();
      return sql<boolean>`exists (
        select 1
        from ${messages}
        inner join ${gmailMessageLabels}
          on ${gmailMessageLabels.messageId} = ${messages.id}
        inner join ${gmailLabels}
          on ${gmailLabels.id} = ${gmailMessageLabels.gmailLabelId}
        where ${messages.threadId} = ${threads.id}
          and ${gmailLabels.providerLabelId} = ${providerLabelId}
      )`;
    }
  }
}

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

type GmailAuthenticationInput = {
  userId: string;
  displayName: string | null;
  providerAccountId: string;
  email: string;
  scopes: string[];
  currentHistoryId: string;
  tokenCiphertext: string;
  authenticatedAt: Date;
};

type NewGmailConnectionInput = GmailAuthenticationInput & {
  initialHistoryId: string;
  watch: {
    topicName: string;
    historyId: string;
    expirationAt: Date;
  };
};

type GmailAuthenticationAccount = {
  id: string;
  userId: string;
  replicaState: typeof gmailReplicaStates.$inferSelect.state | null;
  historyCursor: string | null;
};

async function lockGmailAuthentication(
  transaction: DatabaseTransaction,
  providerAccountId: string,
) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`invook:gmail-auth:${providerAccountId}`}, 0))`,
  );
}

async function findGmailAuthenticationAccount(
  transaction: DatabaseTransaction,
  providerAccountId: string,
): Promise<GmailAuthenticationAccount | null> {
  const [account] = await transaction
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      replicaState: gmailReplicaStates.state,
      historyCursor: gmailReplicaStates.historyCursor,
    })
    .from(connectedAccounts)
    .leftJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return account ?? null;
}

async function saveNewGmailProfile(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
) {
  await transaction
    .insert(profiles)
    .values({
      id: input.userId,
      displayName: input.displayName,
      memoryAcknowledgedAt: input.authenticatedAt,
    })
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        displayName: input.displayName,
        memoryAcknowledgedAt: input.authenticatedAt,
        updatedAt: new Date(),
      },
    });
}

async function saveGmailCredential(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
  accountId: string,
) {
  await transaction
    .insert(accountSecrets)
    .values({
      accountId,
      tokenCiphertext: input.tokenCiphertext,
      keyVersion: 1,
      refreshedAt: input.authenticatedAt,
    })
    .onConflictDoUpdate({
      target: accountSecrets.accountId,
      set: {
        tokenCiphertext: input.tokenCiphertext,
        keyVersion: 1,
        refreshedAt: input.authenticatedAt,
        updatedAt: new Date(),
      },
    });
}

async function saveGmailProfileAndCredential(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
  accountId: string,
) {
  await transaction
    .update(profiles)
    .set({ displayName: input.displayName, updatedAt: new Date() })
    .where(eq(profiles.id, input.userId));
  await transaction
    .update(connectedAccounts)
    .set({
      email: input.email,
      status: "connected",
      scopes: input.scopes,
      updatedAt: new Date(),
    })
    .where(eq(connectedAccounts.id, accountId));
  await saveGmailCredential(transaction, input, accountId);
}

async function saveReturningGmailAuthentication(
  transaction: DatabaseTransaction,
  input: GmailAuthenticationInput,
  account: GmailAuthenticationAccount,
) {
  if (account.userId !== input.userId) {
    throw new Error("This Gmail account is already linked to another Invook user.");
  }
  await saveGmailProfileAndCredential(transaction, input, account.id);

  if (
    account.replicaState === "ready" &&
    account.historyCursor &&
    account.historyCursor !== input.currentHistoryId
  ) {
    const [activeCatchup] = await transaction
      .select({ id: workflowSteps.id })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.accountId, account.id),
          eq(workflowSteps.stepType, "gmail.history.catchup"),
          inArray(workflowSteps.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (!activeCatchup) {
      await enqueueWorkflowStep(
        {
          userId: input.userId,
          accountId: account.id,
          stepType: "gmail.history.catchup",
          payload: { reason: "oauth_reauthentication" },
          idempotencyKey: `gmail-history-reauth:${account.id}:${input.currentHistoryId}:${input.authenticatedAt.toISOString()}`,
        },
        transaction as unknown as Database,
      );
    }
  }

  await transaction.insert(auditEvents).values({
    userId: input.userId,
    accountId: account.id,
    eventType: "gmail.reauthenticated",
    targetType: "connected_account",
    targetId: account.id,
    metadata: { scopes: input.scopes },
  });
  return { id: account.id };
}

export async function refreshGmailAuthentication(
  input: GmailAuthenticationInput,
  database: Database = getDatabase(),
): Promise<{ id: string } | null> {
  return database.transaction(async (transaction) => {
    await lockGmailAuthentication(transaction, input.providerAccountId);
    const account = await findGmailAuthenticationAccount(
      transaction,
      input.providerAccountId,
    );
    if (!account) return null;
    return saveReturningGmailAuthentication(transaction, input, account);
  });
}

export async function saveNewGmailConnection(
  input: NewGmailConnectionInput,
  database: Database = getDatabase(),
): Promise<{ id: string; created: boolean }> {
  return database.transaction(async (transaction) => {
    await lockGmailAuthentication(transaction, input.providerAccountId);
    const existingAccount = await findGmailAuthenticationAccount(
      transaction,
      input.providerAccountId,
    );
    if (existingAccount) {
      const account = await saveReturningGmailAuthentication(
        transaction,
        input,
        existingAccount,
      );
      return { ...account, created: false };
    }

    await saveNewGmailProfile(transaction, input);

    const [account] = await transaction
      .insert(connectedAccounts)
      .values({
        userId: input.userId,
        provider: "gmail",
        providerAccountId: input.providerAccountId,
        email: input.email,
        status: "connected",
        scopes: input.scopes,
        memoryAcknowledgedAt: input.authenticatedAt,
        syncState: initialSyncState,
      })
      .returning({ id: connectedAccounts.id });

    if (!account) throw new Error("The Gmail connection could not be saved.");

    await transaction
      .insert(gmailReplicaStates)
      .values({
        accountId: account.id,
        initialHistoryId: input.initialHistoryId,
        historyCursor: null,
        state: "pending",
      });
    await transaction
      .insert(gmailWatchStates)
      .values({ accountId: account.id, ...input.watch });
    await transaction.insert(mailLabels).values(
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
    );
    await saveGmailCredential(transaction, input, account.id);

    await createInitialMailSyncRun(
      {
        userId: input.userId,
        accountId: account.id,
        startingHistoryCursor: input.initialHistoryId,
      },
      transaction as unknown as Database,
    );
    await enqueueWorkflowStep(
      {
        userId: input.userId,
        accountId: account.id,
        stepType: "gmail.watch.renew",
        payload: {
          runAt: new Date(
            Math.max(
              input.watch.expirationAt.getTime() - 24 * 60 * 60 * 1_000,
              Date.now(),
            ),
          ).toISOString(),
        },
        idempotencyKey: `gmail-watch-renew:${account.id}:${input.watch.expirationAt.toISOString()}`,
      },
      transaction as unknown as Database,
    );

    await transaction.insert(auditEvents).values({
      userId: input.userId,
      accountId: account.id,
      eventType: "gmail.connected",
      targetType: "connected_account",
      targetId: account.id,
      metadata: {
        scopes: input.scopes,
        initialHistoryId: input.initialHistoryId,
        watchExpiration: input.watch.expirationAt.toISOString(),
      },
    });

    return { ...account, created: true };
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
      replicaState: gmailReplicaStates.state,
      replicaReadyAt: gmailReplicaStates.readyAt,
      replicaLastAuditAt: gmailReplicaStates.lastAuditAt,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
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
  if (
    input.embedding &&
    input.embedding.dimensions !== MAIL_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `Mailbox search embeddings must have ${MAIL_EMBEDDING_DIMENSIONS} dimensions.`,
    );
  }
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
          semanticSimilarity: sql<number>`1 - (${messageEmbeddings.embedding} <=> ${`[${input.embedding.values.join(",")}]`}::vector(1536))`,
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
            sql`${messageEmbeddings.embedding} <=> ${`[${input.embedding.values.join(",")}]`}::vector(1536)`,
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
            contentId: messageAttachments.contentId,
            contentDisposition: messageAttachments.contentDisposition,
            checksumSha256: messageAttachments.checksumSha256,
            contentLength: messageAttachments.contentLength,
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
      replicaState: gmailReplicaStates.state,
      replicaReadyAt: gmailReplicaStates.readyAt,
      replicaLastAuditAt: gmailReplicaStates.lastAuditAt,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
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
          providerThreadId: threads.providerThreadId,
          subject: threads.subject,
          participants: threads.participants,
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
  const gmailLabelRows =
    threadIds.length > 0
      ? await database
          .select({
            threadId: messages.threadId,
            id: gmailLabels.id,
            providerLabelId: gmailLabels.providerLabelId,
            name: gmailLabels.name,
            type: gmailLabels.type,
            color: gmailLabels.color,
          })
          .from(messages)
          .innerJoin(
            gmailMessageLabels,
            eq(gmailMessageLabels.messageId, messages.id),
          )
          .innerJoin(gmailLabels, eq(gmailLabels.id, gmailMessageLabels.gmailLabelId))
          .where(inArray(messages.threadId, threadIds))
      : [];
  const labelsByThread = new Map<string, typeof appliedLabelRows>();
  for (const label of appliedLabelRows) {
    const current = labelsByThread.get(label.threadId) ?? [];
    current.push(label);
    labelsByThread.set(label.threadId, current);
  }
  const gmailLabelsByThread = new Map<
    string,
    Array<(typeof gmailLabelRows)[number]>
  >();
  const seenGmailLabels = new Set<string>();
  for (const label of gmailLabelRows) {
    const key = `${label.threadId}:${label.id}`;
    if (seenGmailLabels.has(key)) continue;
    seenGmailLabels.add(key);
    const current = gmailLabelsByThread.get(label.threadId) ?? [];
    current.push(label);
    gmailLabelsByThread.set(label.threadId, current);
  }
  const attachLabels = <T extends { id: string }>(thread: T) => ({
    ...thread,
    gmailLabels: (gmailLabelsByThread.get(thread.id) ?? []).map((label) => ({
      id: label.id,
      providerLabelId: label.providerLabelId,
      name: label.name,
      type: label.type,
      color: label.color,
    })),
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

  const memoryBatchSubmission = await getLatestMemoryBatchSubmission(
    account.id,
    database,
  );

  if (!selectedThread) {
    return {
      account,
      memoryBatchSubmission,
      memories: serializedMemories,
      labels: serializedLabels,
      pagination,
      threads: mailboxThreadsWithLabels,
      selectedThread: null,
    };
  }

  const threadMessages = await database
    .select({
      id: messages.id,
      providerMessageId: messages.providerMessageId,
      providerHistoryId: messages.providerHistoryId,
      internalDate: messages.internalDate,
      sizeEstimate: messages.sizeEstimate,
      headerLines: messages.headerLines,
      direction: messages.direction,
      sender: messages.sender,
      recipients: messages.recipients,
      subject: messages.subject,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      rawChecksumSha256: messages.rawChecksumSha256,
      rawContentLength: messages.rawContentLength,
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
            contentId: messageAttachments.contentId,
            contentDisposition: messageAttachments.contentDisposition,
            checksumSha256: messageAttachments.checksumSha256,
            contentLength: messageAttachments.contentLength,
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

  const messageGmailLabelRows =
    messageIds.length > 0
      ? await database
          .select({
            messageId: gmailMessageLabels.messageId,
            id: gmailLabels.id,
            providerLabelId: gmailLabels.providerLabelId,
            name: gmailLabels.name,
            type: gmailLabels.type,
            color: gmailLabels.color,
          })
          .from(gmailMessageLabels)
          .innerJoin(gmailLabels, eq(gmailLabels.id, gmailMessageLabels.gmailLabelId))
          .where(inArray(gmailMessageLabels.messageId, messageIds))
      : [];
  const gmailLabelsByMessage = new Map<string, typeof messageGmailLabelRows>();
  for (const label of messageGmailLabelRows) {
    const current = gmailLabelsByMessage.get(label.messageId) ?? [];
    current.push(label);
    gmailLabelsByMessage.set(label.messageId, current);
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

  const providerDrafts = await database
    .select({
      id: gmailDrafts.id,
      providerDraftId: gmailDrafts.providerDraftId,
      providerMessageId: gmailDrafts.providerMessageId,
      providerThreadId: gmailDrafts.providerThreadId,
      updatedAt: gmailDrafts.updatedAt,
    })
    .from(gmailDrafts)
    .where(
      and(
        eq(gmailDrafts.accountId, account.id),
        eq(gmailDrafts.providerThreadId, selectedThread.providerThreadId),
        isNotNull(gmailDrafts.providerMessageId),
      ),
    )
    .orderBy(desc(gmailDrafts.updatedAt));

  return {
    account,
    memoryBatchSubmission,
    memories: serializedMemories,
    labels: serializedLabels,
    pagination,
    threads: mailboxThreadsWithLabels,
    selectedThread: {
      ...attachLabels(selectedThread),
      messages: threadMessages.map((message) => ({
        ...message,
        headers: message.headerLines.map((header) => {
          const separator = header.line.indexOf(":");
          return {
            name: header.key,
            value:
              separator >= 0 ? header.line.slice(separator + 1).trimStart() : "",
          };
        }),
        gmailLabels: (gmailLabelsByMessage.get(message.id) ?? []).map(
          (label) => ({
            id: label.id,
            providerLabelId: label.providerLabelId,
            name: label.name,
            type: label.type,
            color: label.color,
          }),
        ),
        rawMime:
          message.rawChecksumSha256 && message.rawContentLength !== null
            ? {
                checksumSha256: message.rawChecksumSha256,
                contentLength: message.rawContentLength,
              }
            : null,
        attachments: attachmentsByMessage.get(message.id) ?? [],
      })),
      aiReplyDraft:
        threadDraft && threadDraft.generatedText
          ? {
              ...threadDraft,
              generatedText: threadDraft.generatedText,
              updatedAt: threadDraft.updatedAt.toISOString(),
            }
          : null,
      gmailDrafts: providerDrafts.flatMap((draft) =>
        draft.providerMessageId === null
          ? []
          : [
              {
                ...draft,
                providerMessageId: draft.providerMessageId,
                updatedAt: draft.updatedAt.toISOString(),
              },
            ],
      ),
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
      historyCursor: gmailReplicaStates.historyCursor,
      initialHistoryId: gmailReplicaStates.initialHistoryId,
      replicaState: gmailReplicaStates.state,
      syncState: connectedAccounts.syncState,
      tokenCiphertext: accountSecrets.tokenCiphertext,
    })
    .from(connectedAccounts)
    .innerJoin(accountSecrets, eq(accountSecrets.accountId, connectedAccounts.id))
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
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

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function invalidateThreadAnalysis(
  transaction: DatabaseTransaction,
  accountId: string,
  threadId: string,
) {
  await transaction
    .delete(threadLabelAnalyses)
    .where(eq(threadLabelAnalyses.threadId, threadId));
  await transaction
    .delete(threadLabels)
    .where(and(eq(threadLabels.threadId, threadId), eq(threadLabels.source, "ai")));
  await transaction
    .update(mailLabels)
    .set({ analysisState: "pending", updatedAt: new Date() })
    .where(eq(mailLabels.accountId, accountId));
}

async function refreshIndexedThread(
  transaction: DatabaseTransaction,
  threadId: string,
  incrementContentVersion = true,
): Promise<boolean> {
  const threadMessages = await transaction
    .select({
      sender: messages.sender,
      recipients: messages.recipients,
      subject: messages.subject,
      snippet: messages.snippet,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt));

  const latestMessage = threadMessages[0];
  if (!latestMessage) {
    await transaction.delete(threads).where(eq(threads.id, threadId));
    return false;
  }

  const participants = Array.from(
    new Set(
      threadMessages.flatMap((message) => [
        message.sender.raw,
        ...message.recipients,
      ]),
    ),
  ).filter(Boolean);
  await transaction
    .update(threads)
    .set({
      subject: latestMessage.subject,
      snippet: latestMessage.snippet,
      participants,
      latestMessageAt: latestMessage.sentAt,
      messageCount: threadMessages.length,
      ...(incrementContentVersion
        ? { contentVersion: sql`${threads.contentVersion} + 1` }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(threads.id, threadId));
  return true;
}

export async function upsertIndexedMessage(
  input: IndexedMessage,
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.accountId}:${input.providerThreadId}`}, 0))`,
    );
    const [existingThread] = await transaction
      .select({ id: threads.id })
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
    }

    if (!threadId) throw new Error("The Gmail thread could not be stored.");

    const [existingMessage] = await transaction
      .select({
        id: messages.id,
        direction: messages.direction,
        sender: messages.sender,
        recipients: messages.recipients,
        providerHistoryId: messages.providerHistoryId,
        internalDate: messages.internalDate,
        sizeEstimate: messages.sizeEstimate,
        headerLines: messages.headerLines,
        subject: messages.subject,
        snippet: messages.snippet,
        bodyText: messages.bodyText,
        bodyHtml: messages.bodyHtml,
        rawObjectKey: messages.rawObjectKey,
        rawChecksumSha256: messages.rawChecksumSha256,
        rawContentLength: messages.rawContentLength,
        rawEtag: messages.rawEtag,
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
    const existingMemberships = existingMessage
      ? await transaction
          .select({ providerLabelId: gmailLabels.providerLabelId })
          .from(gmailMessageLabels)
          .innerJoin(gmailLabels, eq(gmailLabels.id, gmailMessageLabels.gmailLabelId))
          .where(eq(gmailMessageLabels.messageId, existingMessage.id))
      : [];
    const currentGmailLabelIds = existingMemberships.map(
      (membership) => membership.providerLabelId,
    );
    const analysisChanged =
      !existingMessage ||
      existingMessage.direction !== input.direction ||
      !equalSender(existingMessage.sender, input.sender) ||
      !equalStringArrays(existingMessage.recipients, input.recipients) ||
      existingMessage.providerHistoryId !== input.providerHistoryId ||
      existingMessage.internalDate.getTime() !== input.internalDate.getTime() ||
      existingMessage.sizeEstimate !== input.sizeEstimate ||
      JSON.stringify(existingMessage.headerLines) !== JSON.stringify(input.headerLines) ||
      existingMessage.subject !== input.subject ||
      existingMessage.bodyText !== input.bodyText ||
      existingMessage.bodyHtml !== input.bodyHtml ||
      existingMessage.rawObjectKey !== (input.rawObject?.key ?? null) ||
      existingMessage.rawChecksumSha256 !==
        (input.rawObject?.checksumSha256 ?? null) ||
      existingMessage.rawContentLength !==
        (input.rawObject?.contentLength ?? null) ||
      existingMessage.rawEtag !== (input.rawObject?.etag ?? null) ||
      existingMessage.sentAt.getTime() !== input.sentAt.getTime() ||
      existingMessage.isMemoryEligible !== input.isMemoryEligible;
    const changed =
      analysisChanged ||
      !equalStringArrays(currentGmailLabelIds, input.gmailLabelIds) ||
      (existingMessage?.snippet ?? "") !== input.snippet;

    let messageId = existingMessage?.id;
    if (changed) {
      const [storedMessage] = await transaction
        .insert(messages)
        .values({
          userId: input.userId,
          accountId: input.accountId,
          threadId,
          providerMessageId: input.providerMessageId,
          direction: input.direction,
          sender: input.sender,
          recipients: input.recipients,
          providerHistoryId: input.providerHistoryId,
          internalDate: input.internalDate,
          sizeEstimate: input.sizeEstimate,
          headerLines: input.headerLines,
          subject: input.subject,
          snippet: input.snippet,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          rawObjectKey: input.rawObject?.key ?? null,
          rawChecksumSha256: input.rawObject?.checksumSha256 ?? null,
          rawContentLength: input.rawObject?.contentLength ?? null,
          rawEtag: input.rawObject?.etag ?? null,
          sentAt: input.sentAt,
          isMemoryEligible: input.isMemoryEligible,
        })
        .onConflictDoUpdate({
          target: [messages.threadId, messages.providerMessageId],
          set: {
            direction: input.direction,
            sender: input.sender,
            recipients: input.recipients,
            providerHistoryId: input.providerHistoryId,
            internalDate: input.internalDate,
            sizeEstimate: input.sizeEstimate,
            headerLines: input.headerLines,
            subject: input.subject,
            snippet: input.snippet,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            rawObjectKey: input.rawObject?.key ?? null,
            rawChecksumSha256: input.rawObject?.checksumSha256 ?? null,
            rawContentLength: input.rawObject?.contentLength ?? null,
            rawEtag: input.rawObject?.etag ?? null,
            sentAt: input.sentAt,
            isMemoryEligible: input.isMemoryEligible,
            updatedAt: new Date(),
          },
        })
        .returning({ id: messages.id });
      messageId = storedMessage?.id;
      if (!messageId) throw new Error("The Gmail message could not be stored.");

      const requestedProviderLabelIds = Array.from(new Set(input.gmailLabelIds));
      let providerLabels: Array<{ id: string; providerLabelId: string }> = [];
      if (requestedProviderLabelIds.length > 0) {
        providerLabels = await transaction
          .select({
            id: gmailLabels.id,
            providerLabelId: gmailLabels.providerLabelId,
          })
          .from(gmailLabels)
          .where(
            and(
              eq(gmailLabels.accountId, input.accountId),
              inArray(gmailLabels.providerLabelId, requestedProviderLabelIds),
            ),
          );
        const storedProviderLabelIds = new Set(
          providerLabels.map((label) => label.providerLabelId),
        );
        const missingProviderLabelIds = requestedProviderLabelIds.filter(
          (providerLabelId) => !storedProviderLabelIds.has(providerLabelId),
        );
        if (missingProviderLabelIds.length > 0) {
          throw new GmailLabelCatalogMismatchError({
            accountId: input.accountId,
            providerMessageId: input.providerMessageId,
            missingProviderLabelIds,
          });
        }
      }
      await transaction
        .delete(gmailMessageLabels)
        .where(eq(gmailMessageLabels.messageId, messageId));
      if (providerLabels.length > 0) {
        await transaction.insert(gmailMessageLabels).values(
          providerLabels.map((label) => ({
            accountId: input.accountId,
            messageId,
            gmailLabelId: label.id,
          })),
        );
      }
      await transaction
        .delete(gmailMessageTombstones)
        .where(
          and(
            eq(gmailMessageTombstones.accountId, input.accountId),
            eq(gmailMessageTombstones.providerMessageId, input.providerMessageId),
          ),
        );

      if (analysisChanged) {
        await invalidateThreadAnalysis(transaction, input.accountId, threadId);
      }

      if (analysisChanged && input.ingestionMode === "incremental") {
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

      await transaction
        .delete(messageAttachments)
        .where(eq(messageAttachments.messageId, messageId));
      const attachments = input.attachments ?? [];
      if (attachments.length > 0) {
        await transaction.insert(messageAttachments).values(
          attachments.map((attachment) => ({
            userId: input.userId,
            accountId: input.accountId,
            messageId,
            providerAttachmentId: attachment.providerAttachmentId,
            mimePartPath: attachment.mimePartPath,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            contentId: attachment.contentId,
            contentDisposition: attachment.contentDisposition,
            size: attachment.size,
            objectKey: attachment.objectKey,
            checksumSha256: attachment.checksumSha256,
            contentLength: attachment.contentLength,
            etag: attachment.etag,
          })),
        );
      }

      if (analysisChanged) {
        const contentHash = createMessageContentHash(input);
        await transaction
          .delete(messageEmbeddings)
          .where(
            and(
              eq(messageEmbeddings.messageId, messageId),
              ne(messageEmbeddings.contentHash, contentHash),
            ),
          );
        if (input.ingestionMode === "incremental") {
          await enqueueWorkflowStep(
            {
              userId: input.userId,
              accountId: input.accountId,
              stepType: "embedding.incremental",
              payload: { messageId },
              idempotencyKey: `embedding.incremental:${messageId}:${contentHash}`,
            },
            transaction as unknown as Database,
          );
        }
      }
    }

    if (changed) {
      await refreshIndexedThread(transaction, threadId, analysisChanged);
    }

    return { messageId, threadId, changed };
  });
}

export async function deleteIndexedMessage(
  input: {
    accountId: string;
    providerMessageId: string;
    providerHistoryId?: string | null;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [storedMessage] = await transaction
      .select({
        id: messages.id,
        userId: messages.userId,
        threadId: messages.threadId,
        providerThreadId: threads.providerThreadId,
        providerHistoryId: messages.providerHistoryId,
        rawObjectKey: messages.rawObjectKey,
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(
        and(
          eq(threads.accountId, input.accountId),
          eq(messages.providerMessageId, input.providerMessageId),
        ),
      )
      .limit(1);
    if (!storedMessage) return { changed: false, threadId: null };

    const attachmentObjects = await transaction
      .select({ objectKey: messageAttachments.objectKey })
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, storedMessage.id));
    const objectKeys = [
      storedMessage.rawObjectKey,
      ...attachmentObjects.map((attachment) => attachment.objectKey),
    ].filter((key): key is string => Boolean(key));
    await transaction
      .insert(gmailMessageTombstones)
      .values({
        userId: storedMessage.userId,
        accountId: input.accountId,
        providerMessageId: input.providerMessageId,
        providerThreadId: storedMessage.providerThreadId,
        providerHistoryId:
          input.providerHistoryId ?? storedMessage.providerHistoryId,
        objectKeys,
        deletedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          gmailMessageTombstones.accountId,
          gmailMessageTombstones.providerMessageId,
        ],
        set: {
          providerThreadId: storedMessage.providerThreadId,
          providerHistoryId:
            input.providerHistoryId ?? storedMessage.providerHistoryId,
          objectKeys,
          deletedAt: new Date(),
          updatedAt: new Date(),
        },
      });

    await transaction.delete(messages).where(eq(messages.id, storedMessage.id));
    await invalidateThreadAnalysis(
      transaction,
      input.accountId,
      storedMessage.threadId,
    );
    await refreshIndexedThread(transaction, storedMessage.threadId);

    return { changed: true, threadId: storedMessage.threadId, objectKeys };
  });
}

export async function getIndexedMessageIds(
  accountId: string,
  database: Database = getDatabase(),
) {
  const storedMessages = await database
    .select({ providerMessageId: messages.providerMessageId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(eq(threads.accountId, accountId));
  return storedMessages.map((message) => message.providerMessageId);
}

export function createMessageContentHash(
  input: Pick<MailboxMessage, "subject" | "bodyText">,
): string {
  return createHash("sha256")
    .update(`${input.subject.trim()}\n${input.bodyText.trim()}`)
    .digest("hex");
}

export const upsertMailboxMessage = upsertIndexedMessage;

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
          historyCursor: gmailReplicaStates.historyCursor,
          replicaState: gmailReplicaStates.state,
          replicaLastAuditAt: gmailReplicaStates.lastAuditAt,
        })
        .from(connectedAccounts)
        .innerJoin(
          gmailReplicaStates,
          eq(gmailReplicaStates.accountId, connectedAccounts.id),
        )
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

      if (
        account.syncState.mailSync === "complete" &&
        account.replicaState === "ready" &&
        account.replicaLastAuditAt &&
        account.historyCursor
      ) {
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
      contentVersion: threads.contentVersion,
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
      messageId: messages.id,
      threadId: messages.threadId,
      direction: messages.direction,
      sender: messages.sender,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
      rank: sql<number>`row_number() over (partition by ${messages.threadId} order by ${messages.sentAt} desc, ${messages.id} desc)`.as(
        "message_rank",
      ),
    })
    .from(messages)
    .where(inArray(messages.threadId, threadIds))
    .as("ranked_label_messages");
  const messageRows = await database
    .select({
      messageId: rankedMessages.messageId,
      threadId: rankedMessages.threadId,
      direction: rankedMessages.direction,
      sender: rankedMessages.sender,
      bodyText: rankedMessages.bodyText,
      sentAt: rankedMessages.sentAt,
    })
    .from(rankedMessages)
    .where(lte(rankedMessages.rank, 3))
    .orderBy(desc(rankedMessages.sentAt), desc(rankedMessages.messageId));

  const messagesByThread = new Map<string, typeof messageRows>();
  for (const message of messageRows) {
    const grouped = messagesByThread.get(message.threadId) ?? [];
    grouped.push(message);
    messagesByThread.set(message.threadId, grouped);
  }

  return threadRows.map((thread) => ({
    id: thread.id,
    contentVersion: thread.contentVersion,
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
      threadVersion: number;
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
    if (!label) return null;

    const staleThreadIds = new Set<string>();
    let savedThreadCount = 0;
    for (let offset = 0; offset < input.results.length; offset += 500) {
      const requestedResults = input.results.slice(offset, offset + 500);
      const requestedThreadIds = requestedResults.map((result) => result.threadId);
      const currentThreads = await transaction
        .select({ id: threads.id, contentVersion: threads.contentVersion })
        .from(threads)
        .where(
          and(
            eq(threads.accountId, input.accountId),
            inArray(threads.id, requestedThreadIds),
          ),
        )
        .for("update");
      const currentVersions = new Map(
        currentThreads.map((thread) => [thread.id, thread.contentVersion]),
      );
      const results = requestedResults.filter((result) => {
        const currentVersion = currentVersions.get(result.threadId);
        if (currentVersion === result.threadVersion) return true;
        staleThreadIds.add(result.threadId);
        return false;
      });
      if (results.length === 0) continue;

      savedThreadCount += results.length;
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
    return { savedThreadCount, staleThreadIds: Array.from(staleThreadIds) };
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

type EmbeddingBatchManifest = Array<{
  key: string;
  messageId: string;
  contentHash: string;
}>;

export async function getEmbeddingBatchSubmissionForStep(
  workflowStepId: string,
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .select()
    .from(embeddingBatchSubmissions)
    .where(eq(embeddingBatchSubmissions.workflowStepId, workflowStepId))
    .limit(1);
  return submission ?? null;
}

export async function getActiveEmbeddingBatchSubmissionForAccount(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .select({
      id: embeddingBatchSubmissions.id,
      workflowStepId: embeddingBatchSubmissions.workflowStepId,
      providerBatchId: embeddingBatchSubmissions.providerBatchId,
      status: embeddingBatchSubmissions.status,
    })
    .from(embeddingBatchSubmissions)
    .where(
      and(
        eq(embeddingBatchSubmissions.accountId, accountId),
        inArray(embeddingBatchSubmissions.status, ["preparing", "submitted"]),
      ),
    )
    .limit(1);
  return submission ?? null;
}

export async function prepareEmbeddingBatchSubmission(
  input: {
    workflowStepId: string;
    userId: string;
    accountId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    batchAttempt: number;
    hasMore: boolean;
    manifest: EmbeddingBatchManifest;
  },
  database: Database = getDatabase(),
) {
  const [inserted] = await database
    .insert(embeddingBatchSubmissions)
    .values({
      workflowStepId: input.workflowStepId,
      userId: input.userId,
      accountId: input.accountId,
      modelId: input.modelId,
      dimensions: input.dimensions,
      indexVersion: input.indexVersion,
      batchAttempt: input.batchAttempt,
      hasMore: input.hasMore,
      requestCount: input.manifest.length,
      manifest: input.manifest,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const existing = await getEmbeddingBatchSubmissionForStep(
    input.workflowStepId,
    database,
  );
  return existing;
}

export async function refreshPreparingEmbeddingBatchSubmission(
  input: {
    submissionId: string;
    modelId: string;
    dimensions: number;
    indexVersion: number;
    batchAttempt: number;
    hasMore: boolean;
    manifest: EmbeddingBatchManifest;
  },
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .update(embeddingBatchSubmissions)
    .set({
      modelId: input.modelId,
      dimensions: input.dimensions,
      indexVersion: input.indexVersion,
      batchAttempt: input.batchAttempt,
      hasMore: input.hasMore,
      requestCount: input.manifest.length,
      manifest: input.manifest,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(embeddingBatchSubmissions.id, input.submissionId),
        eq(embeddingBatchSubmissions.status, "preparing"),
        isNull(embeddingBatchSubmissions.inputFileId),
        isNull(embeddingBatchSubmissions.providerBatchId),
      ),
    )
    .returning();
  return submission ?? null;
}

export async function recordEmbeddingBatchInputFile(
  input: { submissionId: string; inputFileId: string },
  database: Database = getDatabase(),
): Promise<string> {
  const [submission] = await database
    .update(embeddingBatchSubmissions)
    .set({
      inputFileId: sql`coalesce(${embeddingBatchSubmissions.inputFileId}, ${input.inputFileId})`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(embeddingBatchSubmissions.id, input.submissionId),
        eq(embeddingBatchSubmissions.status, "preparing"),
      ),
    )
    .returning({ inputFileId: embeddingBatchSubmissions.inputFileId });
  if (!submission?.inputFileId) {
    throw new Error("The embedding batch input file could not be recorded.");
  }
  return submission.inputFileId;
}

export async function recordEmbeddingProviderBatch(
  input: {
    submissionId: string;
    providerBatchId: string;
    inputFileId: string;
  },
  database: Database = getDatabase(),
) {
  const [submission] = await database
    .update(embeddingBatchSubmissions)
    .set({
      providerBatchId: input.providerBatchId,
      inputFileId: input.inputFileId,
      status: "submitted",
      submittedAt: sql`coalesce(${embeddingBatchSubmissions.submittedAt}, now())`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(embeddingBatchSubmissions.id, input.submissionId),
        inArray(embeddingBatchSubmissions.status, ["preparing", "submitted"]),
      ),
    )
    .returning();
  if (!submission) {
    throw new Error("The OpenAI embedding batch could not be recorded.");
  }
  return submission;
}

export async function completeEmbeddingBatchSubmission(
  input: {
    submissionId: string;
    providerState: string;
    error: string | null;
  },
  database: Database = getDatabase(),
) {
  await database
    .update(embeddingBatchSubmissions)
    .set({
      status: "complete",
      providerState: input.providerState,
      lastError: input.error,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(embeddingBatchSubmissions.id, input.submissionId));
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
  input: { accountId?: string } = {},
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database
    .select({ providerBatchId: embeddingBatchSubmissions.providerBatchId })
    .from(embeddingBatchSubmissions)
    .where(
      and(
        eq(embeddingBatchSubmissions.status, "submitted"),
        isNotNull(embeddingBatchSubmissions.providerBatchId),
        input.accountId
          ? eq(embeddingBatchSubmissions.accountId, input.accountId)
          : undefined,
      ),
    )
    .groupBy(embeddingBatchSubmissions.providerBatchId);

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
      historyCursor: gmailReplicaStates.historyCursor,
      replicaState: gmailReplicaStates.state,
      replicaLastAuditAt: gmailReplicaStates.lastAuditAt,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
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
    if (
      account.syncState.mailSync !== "complete" ||
      account.replicaState !== "ready" ||
      !account.replicaLastAuditAt ||
      !account.historyCursor
    ) return [];
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
    const [embeddingSubmission] =
      input.provider === "openai"
        ? await transaction
            .select({
              id: embeddingBatchSubmissions.workflowStepId,
              userId: embeddingBatchSubmissions.userId,
              accountId: embeddingBatchSubmissions.accountId,
              stepType: workflowSteps.stepType,
            })
            .from(embeddingBatchSubmissions)
            .innerJoin(
              workflowSteps,
              eq(workflowSteps.id, embeddingBatchSubmissions.workflowStepId),
            )
            .where(
              and(
                eq(embeddingBatchSubmissions.provider, "openai"),
                eq(
                  embeddingBatchSubmissions.providerBatchId,
                  input.providerBatchId,
                ),
                eq(embeddingBatchSubmissions.status, "submitted"),
              ),
            )
            .limit(1)
        : [];
    const [memorySubmission] = embeddingSubmission
      ? []
      : await transaction
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
              ]),
              sql`${workflowSteps.result}->>'provider' = ${input.provider}`,
              sql`${workflowSteps.result}->>'providerBatchId' = ${input.providerBatchId}`,
            ),
          )
          .orderBy(desc(workflowSteps.updatedAt))
          .limit(1);
    const workflowSubmission = embeddingSubmission ?? memorySubmission;
    const [postgresSubmission] = workflowSubmission
      ? []
      : await transaction
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
    const submission = workflowSubmission ?? postgresSubmission;
    if (!submission) return null;

    const payload = {
      submissionJobId: submission.id,
      webhookId: input.webhookId,
      eventType: input.eventType,
      provider: input.provider,
      providerBatchId: input.providerBatchId,
    };
    const idempotencyKey = `${input.provider}.batch-event:${input.eventType}:${input.providerBatchId}`;
    if (workflowSubmission) {
      const eventJobType = workflowSubmission.stepType.startsWith("embedding.")
        ? "embedding.batch.event"
        : "memory.batch.event";
      await enqueueWorkflowStep(
        {
          userId: workflowSubmission.userId,
          accountId: workflowSubmission.accountId,
          stepType: eventJobType,
          payload,
          idempotencyKey,
        },
        transaction as unknown as Database,
      );
    } else if (postgresSubmission) {
      await transaction.insert(jobs).values({
        userId: postgresSubmission.userId,
        accountId: postgresSubmission.accountId,
        jobType: postgresSubmission.jobType.startsWith("label.")
          ? "label.batch.event"
          : "memory.batch.event",
        status: "queued",
        payload: {
          ...payload,
        },
        attempts: 0,
        idempotencyKey,
      }).onConflictDoNothing({ target: jobs.idempotencyKey });
    }

    return { submissionJobId: submission.id };
  });
}

export async function getBatchSubmission(
  jobId: string,
  database: Database = getDatabase(),
) {
  const workflowSubmission = await getWorkflowStepSubmission(jobId, database);
  if (workflowSubmission) return workflowSubmission;
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
  const payload = {
    parentSubmissionJobId: input.parentSubmissionJobId,
    rootSubmissionJobId: input.rootSubmissionJobId,
    batchAttempt: input.batchAttempt,
    replaceExisting: input.replaceExisting,
    manifest: input.manifest,
  };
  const workflowParent = await getWorkflowStepSubmission(
    input.parentSubmissionJobId,
    database,
  );
  if (workflowParent) {
    return enqueueWorkflowStep(
      {
        userId: input.userId,
        accountId: input.accountId,
        stepType: "memory.batch.retry",
        payload,
        idempotencyKey,
      },
      database,
    );
  }
  const inserted = await database
    .insert(jobs)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      jobType: "memory.batch.retry",
      status: "queued",
      payload,
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
      await transaction
        .update(connectedAccounts)
        .set({
          status: input.reconnectRequired ? "reconnect_required" : "connected",
          syncState: { mailSync: "failed", indexing: "pending", memory: "pending" },
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, accountId));
    }
  });
}
