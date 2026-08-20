import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
} from "./client";
import {
  connectedAccounts,
  labels,
  messageLabels,
  messages,
  threadLabelAssignments,
  threads,
} from "./schema";
import { insertMailboxChange } from "./mailbox-change-events";
import {
  enqueueWorkflowStepsWithExecutor,
  enqueueWorkflowStepWithExecutor,
} from "./workflows";

export type ThreadLabelDefinition = {
  id: string;
  name: string;
  description: string;
  definitionVersion: number;
};

export type ThreadLabelAnalysisCheckpoint = {
  threadId: string;
  analysisVersion: number;
  definitionHash: string;
};

export type HistoricalThreadLabelCheckpoint = {
  threadId: string;
  labelId: string;
  definitionVersion: number;
  assignmentVersion: number | null;
};

export type InboxThreadMessage = {
  id: string;
  subject: string;
  sender: { raw: string; email: string };
  recipients: string[];
  bodyText: string;
  sentAt: Date;
};

export const BUILT_IN_INVOOK_LABELS = [
  {
    name: "Important",
    normalizedName: "important",
    description:
      "Direct personal or work messages that require timely attention, a decision, or an action from the mailbox owner.",
    systemKey: "important" as const,
    definitionVersion: 1,
  },
  {
    name: "Newsletter",
    normalizedName: "newsletter",
    description:
      "Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.",
    systemKey: "newsletter" as const,
    definitionVersion: 1,
  },
  {
    name: "Billing",
    normalizedName: "billing",
    description:
      "Invoices, receipts, payment confirmations, subscription charges, account statements, refunds, or other billing records.",
    systemKey: "billing" as const,
    definitionVersion: 1,
  },
  {
    name: "Others",
    normalizedName: "others",
    description:
      "Fallback for an Inbox thread that does not match any enabled Invook label.",
    systemKey: "others" as const,
    definitionVersion: 1,
  },
] as const;

export async function ensureBuiltInInvookLabels(
  input: { userId: string; accountId: string },
  database: DatabaseExecutor,
): Promise<void> {
  await database
    .insert(labels)
    .values(
      BUILT_IN_INVOOK_LABELS.map((definition) => ({
        userId: input.userId,
        accountId: input.accountId,
        kind: "invook" as const,
        isEnabled: true,
        ...definition,
      })),
    )
    .onConflictDoNothing();
}

function definitionHash(
  definitions: ThreadLabelDefinition[],
  fallback: ThreadLabelDefinition,
): string {
  const canonical = [...definitions, fallback]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      definitionVersion: definition.definitionVersion,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function getDefinitionSnapshot(
  accountId: string,
  database: DatabaseExecutor,
): Promise<{
  definitions: ThreadLabelDefinition[];
  fallback: ThreadLabelDefinition;
  definitionHash: string;
}> {
  const definitionRows = await database
    .select({
      id: labels.id,
      name: labels.name,
      description: labels.description,
      definitionVersion: labels.definitionVersion,
      systemKey: labels.systemKey,
    })
    .from(labels)
    .where(
      and(
        eq(labels.accountId, accountId),
        eq(labels.kind, "invook"),
        eq(labels.isEnabled, true),
      ),
    )
    .orderBy(asc(labels.id));
  const fallbackRow = definitionRows.find(
    (definition) => definition.systemKey === "others",
  );
  if (!fallbackRow) {
    throw new Error("The account has no enabled Others label.");
  }
  const fallback: ThreadLabelDefinition = {
    id: fallbackRow.id,
    name: fallbackRow.name,
    description: fallbackRow.description,
    definitionVersion: fallbackRow.definitionVersion,
  };
  const definitions = definitionRows.flatMap((definition) =>
    definition.systemKey === "others"
      ? []
      : [{
          id: definition.id,
          name: definition.name,
          description: definition.description,
          definitionVersion: definition.definitionVersion,
        }],
  );
  return {
    definitions,
    fallback,
    definitionHash: definitionHash(definitions, fallback),
  };
}

function inboxMembership(messageId: SQLWrapper) {
  return sql<boolean>`exists (
    select 1
    from ${messageLabels} inbox_membership
    inner join ${labels} inbox_label on inbox_label.id = inbox_membership.label_id
    where inbox_membership.message_id = ${messageId}
      and inbox_label.kind = 'gmail'
      and inbox_label.provider_label_id = 'INBOX'
  ) and not exists (
    select 1
    from ${messageLabels} excluded_membership
    inner join ${labels} excluded_label on excluded_label.id = excluded_membership.label_id
    where excluded_membership.message_id = ${messageId}
      and excluded_label.kind = 'gmail'
      and excluded_label.provider_label_id in ('SPAM', 'TRASH')
  )`;
}

export async function listInboxThreadMessages(
  threadId: string,
  database: DatabaseExecutor,
): Promise<InboxThreadMessage[]> {
  return database
    .select({
      id: messages.id,
      subject: messages.subject,
      sender: messages.sender,
      recipients: messages.recipients,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), inboxMembership(messages.id)))
    .orderBy(asc(messages.sentAt), asc(messages.id));
}

export async function refreshThreadProjection(
  database: DatabaseExecutor,
  threadId: string,
  options: { incrementContentVersion?: boolean } = {},
): Promise<boolean> {
  const storedMessages = await database
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
  const latestMessage = storedMessages[0];
  if (!latestMessage) {
    await database.delete(threads).where(eq(threads.id, threadId));
    return false;
  }
  const participants = Array.from(
    new Set(
      storedMessages.flatMap((message) => [
        message.sender.raw,
        ...message.recipients,
      ]),
    ),
  ).filter(Boolean);
  await database
    .update(threads)
    .set({
      subject: latestMessage.subject,
      snippet: latestMessage.snippet,
      participants,
      latestMessageAt: latestMessage.sentAt,
      messageCount: storedMessages.length,
      ...(options.incrementContentVersion === false
        ? {}
        : { contentVersion: sql`${threads.contentVersion} + 1` }),
      updatedAt: new Date(),
    })
    .where(eq(threads.id, threadId));
  return true;
}

export async function enqueueThreadLabelAnalysisWithExecutor(
  input: {
    userId: string;
    accountId: string;
    threadId: string;
    analysisVersion: number;
  },
  database: DatabaseExecutor,
): Promise<{ stepId: string; definitionHash: string }> {
  await ensureBuiltInInvookLabels(
    { userId: input.userId, accountId: input.accountId },
    database,
  );
  const snapshot = await getDefinitionSnapshot(input.accountId, database);
  const stepId = await enqueueWorkflowStepWithExecutor(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "label.thread.assign",
      payload: {
        threadId: input.threadId,
        analysisVersion: input.analysisVersion,
        definitionHash: snapshot.definitionHash,
      },
      idempotencyKey: `label.thread.assign:${input.threadId}:${input.analysisVersion}:${snapshot.definitionHash}`,
    },
    database,
  );
  await database
    .update(threads)
    .set({
      labelAnalysisState: "pending",
      labelAnalysisDefinitionHash: snapshot.definitionHash,
      labelAnalysisError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        eq(threads.labelAnalysisVersion, input.analysisVersion),
      ),
    );
  return { stepId, definitionHash: snapshot.definitionHash };
}

export async function enqueueUnassignedInboxThreadAnalyses(
  input: { userId?: string; accountId?: string } = {},
  database: Database = getDatabase(),
): Promise<number> {
  const candidates = await database
    .select({
      userId: threads.userId,
      accountId: threads.accountId,
      threadId: threads.id,
      analysisVersion: threads.labelAnalysisVersion,
    })
    .from(threads)
    .leftJoin(
      threadLabelAssignments,
      eq(threadLabelAssignments.threadId, threads.id),
    )
    .where(
      and(
        isNull(threadLabelAssignments.id),
        input.userId ? eq(threads.userId, input.userId) : undefined,
        input.accountId ? eq(threads.accountId, input.accountId) : undefined,
        sql<boolean>`exists (
          select 1 from ${messages} eligible_message
          where eligible_message.thread_id = ${threads.id}
            and exists (
              select 1 from ${messageLabels} eligible_membership
              inner join ${labels} eligible_label
                on eligible_label.id = eligible_membership.label_id
              where eligible_membership.message_id = eligible_message.id
                and eligible_label.kind = 'gmail'
                and eligible_label.provider_label_id = 'INBOX'
            )
            and not exists (
              select 1 from ${messageLabels} excluded_membership
              inner join ${labels} excluded_label
                on excluded_label.id = excluded_membership.label_id
              where excluded_membership.message_id = eligible_message.id
                and excluded_label.kind = 'gmail'
                and excluded_label.provider_label_id in ('SPAM', 'TRASH')
            )
        )`,
      ),
    );
  let insertedCount = 0;
  for (const candidate of candidates) {
    await enqueueThreadLabelAnalysisWithExecutor(candidate, database);
    insertedCount += 1;
  }
  return insertedCount;
}

function checkpointMatches(
  thread: { id: string; labelAnalysisVersion: number },
  checkpoint: ThreadLabelAnalysisCheckpoint,
): boolean {
  return (
    thread.id === checkpoint.threadId &&
    thread.labelAnalysisVersion === checkpoint.analysisVersion
  );
}

export async function beginThreadLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: ThreadLabelAnalysisCheckpoint;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" | "resolved" | "ineligible" }
  | {
      status: "ready";
      thread: { id: string; subject: string; messages: InboxThreadMessage[] };
      definitions: ThreadLabelDefinition[];
      fallback: ThreadLabelDefinition;
    }
> {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({
        id: threads.id,
        subject: threads.subject,
        labelAnalysisVersion: threads.labelAnalysisVersion,
        labelAnalysisState: threads.labelAnalysisState,
        assignmentId: threadLabelAssignments.id,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (!thread) return { status: "missing" };
    if (!checkpointMatches(thread, input.checkpoint)) {
      return { status: "superseded" };
    }
    if (thread.assignmentId || thread.labelAnalysisState === "complete") {
      return { status: "resolved" };
    }
    const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: thread.id,
          analysisVersion: thread.labelAnalysisVersion,
        },
        transaction,
      );
      return { status: "superseded" };
    }
    const inboxMessages = await listInboxThreadMessages(thread.id, transaction);
    if (inboxMessages.length === 0) return { status: "ineligible" };

    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "running",
        labelAnalysisError: null,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, thread.id));
    return {
      status: "ready",
      thread: { id: thread.id, subject: thread.subject, messages: inboxMessages },
      definitions: snapshot.definitions,
      fallback: snapshot.fallback,
    };
  });
}

export async function completeThreadLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: ThreadLabelAnalysisCheckpoint;
    modelId: string;
    labelId: string;
    confidence: number;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" | "current" }
  | { status: "complete"; eventId: string }
> {
  return database.transaction(async (transaction) => {
    const [thread] = await transaction
      .select({
        id: threads.id,
        labelAnalysisVersion: threads.labelAnalysisVersion,
        assignmentId: threadLabelAssignments.id,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (!thread) return { status: "missing" };
    if (!checkpointMatches(thread, input.checkpoint)) {
      return { status: "superseded" };
    }
    if (thread.assignmentId) return { status: "current" };

    const snapshot = await getDefinitionSnapshot(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await enqueueThreadLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          threadId: thread.id,
          analysisVersion: thread.labelAnalysisVersion,
        },
        transaction,
      );
      return { status: "superseded" };
    }
    const selectedDefinition = [...snapshot.definitions, snapshot.fallback].find(
      (definition) => definition.id === input.labelId,
    );
    if (
      !selectedDefinition ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100
    ) {
      throw new Error("The thread label result does not match current definitions.");
    }
    const inboxMessages = await listInboxThreadMessages(thread.id, transaction);
    if (inboxMessages.length === 0) return { status: "superseded" };

    await transaction.insert(threadLabelAssignments).values({
      userId: input.userId,
      accountId: input.accountId,
      threadId: thread.id,
      labelId: selectedDefinition.id,
      source: "ai",
      confidence: input.confidence.toFixed(2),
      modelId: input.modelId,
      definitionVersion: selectedDefinition.definitionVersion,
    });
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisDefinitionHash: snapshot.definitionHash,
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, thread.id));
    const eventId = await insertMailboxChange(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        changeType: "labels_changed",
        payload: {
          kind: "analysis_resolution",
          affectedThreadIds: [thread.id],
        },
      });
    return { status: "complete", eventId };
  });
}

export async function failThreadLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: ThreadLabelAnalysisCheckpoint;
    errorCode: string;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  const updated = await database
    .update(threads)
    .set({
      labelAnalysisState: "failed",
      labelAnalysisError: input.errorCode,
      labelAnalyzedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threads.id, input.checkpoint.threadId),
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        eq(threads.labelAnalysisVersion, input.checkpoint.analysisVersion),
        eq(threads.labelAnalysisDefinitionHash, input.checkpoint.definitionHash),
        inArray(threads.labelAnalysisState, ["pending", "running"]),
        sql<boolean>`not exists (
          select 1 from ${threadLabelAssignments}
          where ${threadLabelAssignments.threadId} = ${threads.id}
        )`,
      ),
    )
    .returning({ id: threads.id });
  return updated.length > 0;
}

export async function listInvookLabelPreviewCandidates(
  input: { userId: string; limit?: number },
  database: Database = getDatabase(),
): Promise<Array<{
  threadId: string;
  subject: string;
  sender: { raw: string; email: string };
  sentAt: Date;
  messages: InboxThreadMessage[];
}>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const [account] = await database
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);
  if (!account) return [];
  const candidates = await database
    .select({ id: threads.id, subject: threads.subject })
    .from(threads)
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.accountId, account.id),
        sql<boolean>`exists (
          select 1 from ${messages} preview_message
          where preview_message.thread_id = ${threads.id}
            and ${inboxMembership(sql.raw("preview_message.id"))}
        )`,
      ),
    )
    .orderBy(desc(threads.latestMessageAt), desc(threads.createdAt))
    .limit(limit);
  const results = [];
  for (const candidate of candidates) {
    const inboxMessages = await listInboxThreadMessages(candidate.id, database);
    const latestMessage = inboxMessages.at(-1);
    if (!latestMessage) continue;
    results.push({
      threadId: candidate.id,
      subject: candidate.subject,
      sender: latestMessage.sender,
      sentAt: latestMessage.sentAt,
      messages: inboxMessages,
    });
  }
  return results;
}

export async function enqueueHistoricalThreadLabelScan(
  input: {
    userId: string;
    accountId: string;
    labelId: string;
    definitionVersion: number;
    after: Date;
  },
  database: DatabaseExecutor,
): Promise<number> {
  const candidates = await database
    .select({
      threadId: threads.id,
      assignmentVersion: threadLabelAssignments.assignmentVersion,
    })
    .from(threads)
    .leftJoin(
      threadLabelAssignments,
      eq(threadLabelAssignments.threadId, threads.id),
    )
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        sql<boolean>`exists (
          select 1 from ${messages} scan_message
          where scan_message.thread_id = ${threads.id}
            and scan_message.sent_at >= ${input.after}
            and ${inboxMembership(sql.raw("scan_message.id"))}
        )`,
      ),
    );
  let queuedThreadCount = 0;
  for (let index = 0; index < candidates.length; index += 500) {
    const inserted = await enqueueWorkflowStepsWithExecutor(
      candidates.slice(index, index + 500).map((candidate) => ({
        userId: input.userId,
        accountId: input.accountId,
        stepType: "label.thread.scan",
        payload: {
          threadId: candidate.threadId,
          labelId: input.labelId,
          definitionVersion: input.definitionVersion,
          assignmentVersion: candidate.assignmentVersion,
        },
        idempotencyKey: `label.thread.scan:${candidate.threadId}:${candidate.assignmentVersion ?? "unassigned"}:${input.labelId}:${input.definitionVersion}`,
      })),
      database,
    );
    queuedThreadCount += inserted.length;
  }
  return queuedThreadCount;
}

export async function beginHistoricalThreadLabelScan(
  input: {
    userId: string;
    accountId: string;
    checkpoint: HistoricalThreadLabelCheckpoint;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" }
  | {
      status: "ready";
      thread: { id: string; subject: string; messages: InboxThreadMessage[] };
      definition: ThreadLabelDefinition;
    }
> {
  const [target] = await database
    .select({
      threadId: threads.id,
      subject: threads.subject,
      assignmentVersion: threadLabelAssignments.assignmentVersion,
      labelId: labels.id,
      labelName: labels.name,
      labelDescription: labels.description,
      definitionVersion: labels.definitionVersion,
      isEnabled: labels.isEnabled,
      systemKey: labels.systemKey,
    })
    .from(threads)
    .leftJoin(
      threadLabelAssignments,
      eq(threadLabelAssignments.threadId, threads.id),
    )
    .innerJoin(labels, eq(labels.id, input.checkpoint.labelId))
    .where(
      and(
        eq(threads.id, input.checkpoint.threadId),
        eq(threads.userId, input.userId),
        eq(threads.accountId, input.accountId),
        eq(labels.kind, "invook"),
        eq(labels.userId, input.userId),
        eq(labels.accountId, input.accountId),
      ),
    )
    .limit(1);
  if (!target) return { status: "missing" };
  if (
    target.assignmentVersion !== input.checkpoint.assignmentVersion ||
    target.labelId !== input.checkpoint.labelId ||
    target.definitionVersion !== input.checkpoint.definitionVersion ||
    !target.isEnabled ||
    target.systemKey === "others"
  ) {
    return { status: "superseded" };
  }
  const inboxMessages = await listInboxThreadMessages(target.threadId, database);
  if (inboxMessages.length === 0) return { status: "superseded" };
  return {
    status: "ready",
    thread: { id: target.threadId, subject: target.subject, messages: inboxMessages },
    definition: {
      id: target.labelId,
      name: target.labelName,
      description: target.labelDescription,
      definitionVersion: target.definitionVersion,
    },
  };
}

export async function completeHistoricalThreadLabelScan(
  input: {
    userId: string;
    accountId: string;
    checkpoint: HistoricalThreadLabelCheckpoint;
    modelId: string;
    matched: boolean;
    confidence: number;
  },
  database: Database = getDatabase(),
): Promise<{ status: "missing" | "superseded" | "not_matched" | "complete" }> {
  return database.transaction(async (transaction) => {
    const [target] = await transaction
      .select({
        threadId: threads.id,
        assignmentId: threadLabelAssignments.id,
        assignmentVersion: threadLabelAssignments.assignmentVersion,
        labelId: labels.id,
        definitionVersion: labels.definitionVersion,
        isEnabled: labels.isEnabled,
        systemKey: labels.systemKey,
      })
      .from(threads)
      .leftJoin(
        threadLabelAssignments,
        eq(threadLabelAssignments.threadId, threads.id),
      )
      .innerJoin(labels, eq(labels.id, input.checkpoint.labelId))
      .where(
        and(
          eq(threads.id, input.checkpoint.threadId),
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
          eq(labels.kind, "invook"),
          eq(labels.userId, input.userId),
          eq(labels.accountId, input.accountId),
        ),
      )
      .for("update", { of: threads })
      .limit(1);
    if (!target) return { status: "missing" };
    if (
      target.assignmentVersion !== input.checkpoint.assignmentVersion ||
      target.labelId !== input.checkpoint.labelId ||
      target.definitionVersion !== input.checkpoint.definitionVersion ||
      !target.isEnabled ||
      target.systemKey === "others" ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100
    ) {
      return { status: "superseded" };
    }
    if (!input.matched) return { status: "not_matched" };
    if (target.assignmentId) {
      await transaction
        .update(threadLabelAssignments)
        .set({
          labelId: target.labelId,
          source: "ai",
          confidence: input.confidence.toFixed(2),
          modelId: input.modelId,
          definitionVersion: target.definitionVersion,
          assignmentVersion: sql`${threadLabelAssignments.assignmentVersion} + 1`,
          assignedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(threadLabelAssignments.id, target.assignmentId));
    } else {
      await transaction.insert(threadLabelAssignments).values({
        userId: input.userId,
        accountId: input.accountId,
        threadId: target.threadId,
        labelId: target.labelId,
        source: "ai",
        confidence: input.confidence.toFixed(2),
        modelId: input.modelId,
        definitionVersion: target.definitionVersion,
      });
    }
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, target.threadId));
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      changeType: "labels_changed",
      payload: {
        kind: "analysis_resolution",
        affectedThreadIds: [target.threadId],
      },
    });
    return { status: "complete" };
  });
}

export async function setUserThreadLabel(
  input: { userId: string; threadId: string; labelId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [target] = await transaction
      .select({
        threadId: threads.id,
        accountId: threads.accountId,
        labelId: labels.id,
        labelName: labels.name,
        definitionVersion: labels.definitionVersion,
      })
      .from(threads)
      .innerJoin(
        labels,
        and(
          eq(labels.id, input.labelId),
          eq(labels.userId, input.userId),
          eq(labels.accountId, threads.accountId),
          eq(labels.kind, "invook"),
        ),
      )
      .where(and(eq(threads.id, input.threadId), eq(threads.userId, input.userId)))
      .for("update", { of: threads })
      .limit(1);
    if (!target) return null;
    const [assignment] = await transaction
      .insert(threadLabelAssignments)
      .values({
        userId: input.userId,
        accountId: target.accountId,
        threadId: target.threadId,
        labelId: target.labelId,
        source: "user",
        confidence: null,
        modelId: null,
        definitionVersion: target.definitionVersion,
      })
      .onConflictDoUpdate({
        target: threadLabelAssignments.threadId,
        set: {
          labelId: target.labelId,
          source: "user",
          confidence: null,
          modelId: null,
          definitionVersion: target.definitionVersion,
          assignmentVersion: sql`${threadLabelAssignments.assignmentVersion} + 1`,
          assignedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ assignmentVersion: threadLabelAssignments.assignmentVersion });
    if (!assignment) throw new Error("The thread label could not be saved.");
    await transaction
      .update(threads)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, target.threadId));
    await insertMailboxChange(transaction, {
      userId: input.userId,
      accountId: target.accountId,
      changeType: "labels_changed",
      payload: { kind: "decision", affectedThreadIds: [target.threadId] },
    });
    return {
      labelId: target.labelId,
      name: target.labelName,
      source: "user" as const,
      confidence: null,
    };
  });
}

export async function getThreadLabelAnalysisCounts(
  accountId: string,
  database: Database = getDatabase(),
): Promise<{ pending: number; running: number; complete: number; failed: number }> {
  const rows = await database
    .select({ state: threads.labelAnalysisState, value: sql<number>`count(*)` })
    .from(threads)
    .where(eq(threads.accountId, accountId))
    .groupBy(threads.labelAnalysisState);
  const counts = { pending: 0, running: 0, complete: 0, failed: 0 };
  for (const row of rows) counts[row.state] = Number(row.value);
  return counts;
}
