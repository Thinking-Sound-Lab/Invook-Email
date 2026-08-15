import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
} from "./client";
import {
  labels,
  mailboxChangeEvents,
  messageLabelDecisions,
  messageLabels,
  messages,
  threads,
} from "./schema";
import { enqueueWorkflowStepWithExecutor } from "./workflows";

export type MessageLabelDefinition = {
  id: string;
  name: string;
  description: string;
  definitionVersion: number;
};

export type MessageLabelAnalysisCheckpoint = {
  messageId: string;
  contentHash: string;
  analysisVersion: number;
  definitionHash: string;
};

export type MessageLabelDecisionInput = {
  labelId: string;
  definitionVersion: number;
  matched: boolean;
  confidence: number;
};

export const BUILT_IN_NEWSLETTER_LABEL = {
  name: "Newsletter",
  normalizedName: "newsletter",
  description:
    "Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.",
  systemKey: "newsletter" as const,
  definitionVersion: 1,
};

export async function ensureBuiltInInvookLabels(
  input: { userId: string; accountId: string },
  database: DatabaseExecutor,
): Promise<void> {
  await database
    .insert(labels)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      kind: "invook",
      ...BUILT_IN_NEWSLETTER_LABEL,
    })
    .onConflictDoNothing();
}

function definitionHash(definitions: MessageLabelDefinition[]): string {
  const canonical = [...definitions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      definitionVersion: definition.definitionVersion,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function getDefinitions(
  accountId: string,
  database: DatabaseExecutor,
): Promise<{
  definitions: MessageLabelDefinition[];
  definitionHash: string;
}> {
  const definitions = await database
    .select({
      id: labels.id,
      name: labels.name,
      description: labels.description,
      definitionVersion: labels.definitionVersion,
    })
    .from(labels)
    .where(and(eq(labels.accountId, accountId), eq(labels.kind, "invook")))
    .orderBy(asc(labels.id));
  return { definitions, definitionHash: definitionHash(definitions) };
}

export async function enqueueMessageLabelAnalysisWithExecutor(
  input: {
    userId: string;
    accountId: string;
    messageId: string;
    contentHash: string;
    analysisVersion: number;
  },
  database: DatabaseExecutor,
): Promise<{ stepId: string; definitionHash: string }> {
  const snapshot = await getDefinitions(input.accountId, database);
  const stepId = await enqueueWorkflowStepWithExecutor(
    {
      userId: input.userId,
      accountId: input.accountId,
      stepType: "label.message.analyze",
      payload: {
        messageId: input.messageId,
        contentHash: input.contentHash,
        analysisVersion: input.analysisVersion,
        definitionHash: snapshot.definitionHash,
      },
      idempotencyKey: `label.message.analyze:${input.messageId}:${input.analysisVersion}:${input.contentHash}:${snapshot.definitionHash}`,
    },
    database,
  );
  await database
    .update(messages)
    .set({
      labelAnalysisDefinitionHash: snapshot.definitionHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.userId, input.userId),
        eq(messages.accountId, input.accountId),
        eq(messages.embeddingContentHash, input.contentHash),
        eq(messages.labelAnalysisVersion, input.analysisVersion),
      ),
    );
  return { stepId, definitionHash: snapshot.definitionHash };
}

export async function refreshVisibleThread(
  database: DatabaseExecutor,
  threadId: string,
  options: { incrementContentVersion?: boolean } = {},
): Promise<boolean> {
  const allMessages = await database
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .limit(1);
  if (allMessages.length === 0) {
    await database.delete(threads).where(eq(threads.id, threadId));
    return false;
  }

  const visibleMessages = await database
    .select({
      sender: messages.sender,
      recipients: messages.recipients,
      subject: messages.subject,
      snippet: messages.snippet,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        inArray(messages.labelAnalysisState, ["complete", "failed"]),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.createdAt));
  const latestMessage = visibleMessages[0];
  const participants = Array.from(
    new Set(
      visibleMessages.flatMap((message) => [
        message.sender.raw,
        ...message.recipients,
      ]),
    ),
  ).filter(Boolean);
  await database
    .update(threads)
    .set({
      subject: latestMessage?.subject ?? "",
      snippet: latestMessage?.snippet ?? "",
      participants,
      latestMessageAt: latestMessage?.sentAt ?? null,
      messageCount: visibleMessages.length,
      ...(options.incrementContentVersion === false
        ? {}
        : { contentVersion: sql`${threads.contentVersion} + 1` }),
      updatedAt: new Date(),
    })
    .where(eq(threads.id, threadId));
  return Boolean(latestMessage);
}

async function insertResolutionEvent(
  database: DatabaseExecutor,
  input: {
    userId: string;
    accountId: string;
    messageId: string;
    threadId: string;
    state: "complete" | "failed";
  },
): Promise<string> {
  const [event] = await database
    .insert(mailboxChangeEvents)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      changeType: "labels_changed",
      payload: {
        messageId: input.messageId,
        changedThreadIds: [input.threadId],
        labelAnalysisState: input.state,
      },
    })
    .returning({ id: mailboxChangeEvents.id });
  if (!event) throw new Error("The mailbox label-analysis event was not stored.");
  return event.id;
}

function checkpointMatches(
  message: {
    id: string;
    embeddingContentHash: string;
    labelAnalysisVersion: number;
  },
  checkpoint: MessageLabelAnalysisCheckpoint,
): boolean {
  return (
    message.id === checkpoint.messageId &&
    message.embeddingContentHash === checkpoint.contentHash &&
    message.labelAnalysisVersion === checkpoint.analysisVersion
  );
}

export async function beginMessageLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: MessageLabelAnalysisCheckpoint;
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" | "resolved" }
  | {
      status: "ready";
      message: {
        id: string;
        subject: string;
        sender: { raw: string; email: string };
        recipients: string[];
        bodyText: string;
      };
      definitions: MessageLabelDefinition[];
    }
> {
  return database.transaction(async (transaction) => {
    const [message] = await transaction
      .select({
        id: messages.id,
        subject: messages.subject,
        sender: messages.sender,
        recipients: messages.recipients,
        bodyText: messages.bodyText,
        embeddingContentHash: messages.embeddingContentHash,
        labelAnalysisVersion: messages.labelAnalysisVersion,
        labelAnalysisState: messages.labelAnalysisState,
      })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.checkpoint.messageId),
          eq(messages.userId, input.userId),
          eq(messages.accountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!message) return { status: "missing" };
    if (!checkpointMatches(message, input.checkpoint)) {
      return { status: "superseded" };
    }
    if (
      message.labelAnalysisState === "complete" ||
      message.labelAnalysisState === "failed"
    ) {
      return { status: "resolved" };
    }

    const snapshot = await getDefinitions(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      await transaction
        .update(messages)
        .set({
          labelAnalysisState: "pending",
          labelAnalysisDefinitionHash: snapshot.definitionHash,
          updatedAt: new Date(),
        })
        .where(eq(messages.id, message.id));
      await enqueueMessageLabelAnalysisWithExecutor(
        {
          userId: input.userId,
          accountId: input.accountId,
          messageId: message.id,
          contentHash: message.embeddingContentHash,
          analysisVersion: message.labelAnalysisVersion,
        },
        transaction,
      );
      return { status: "superseded" };
    }

    await transaction
      .update(messages)
      .set({
        labelAnalysisState: "running",
        labelAnalysisError: null,
        labelAnalysisDefinitionHash: snapshot.definitionHash,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id));
    return {
      status: "ready",
      message: {
        id: message.id,
        subject: message.subject,
        sender: message.sender,
        recipients: message.recipients,
        bodyText: message.bodyText,
      },
      definitions: snapshot.definitions,
    };
  });
}

async function supersedeChangedDefinitions(
  database: DatabaseExecutor,
  input: {
    userId: string;
    accountId: string;
    messageId: string;
    contentHash: string;
    analysisVersion: number;
    definitionHash: string;
  },
): Promise<string> {
  await database
    .update(messages)
    .set({
      labelAnalysisState: "pending",
      labelAnalysisDefinitionHash: input.definitionHash,
      labelAnalysisError: null,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, input.messageId));
  const enqueued = await enqueueMessageLabelAnalysisWithExecutor(
    input,
    database,
  );
  return enqueued.stepId;
}

export async function completeMessageLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: MessageLabelAnalysisCheckpoint;
    modelId: string;
    decisions: MessageLabelDecisionInput[];
  },
  database: Database = getDatabase(),
): Promise<
  | { status: "missing" | "superseded" | "current" }
  | { status: "definitions_changed"; nextStepId: string }
  | { status: "complete"; eventId: string }
> {
  return database.transaction(async (transaction) => {
    const [message] = await transaction
      .select({
        id: messages.id,
        threadId: messages.threadId,
        embeddingContentHash: messages.embeddingContentHash,
        labelAnalysisVersion: messages.labelAnalysisVersion,
        labelAnalysisState: messages.labelAnalysisState,
      })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.checkpoint.messageId),
          eq(messages.userId, input.userId),
          eq(messages.accountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!message) return { status: "missing" };
    if (!checkpointMatches(message, input.checkpoint)) {
      return { status: "superseded" };
    }
    if (message.labelAnalysisState === "complete") {
      return { status: "current" };
    }

    const snapshot = await getDefinitions(input.accountId, transaction);
    if (snapshot.definitionHash !== input.checkpoint.definitionHash) {
      const nextStepId = await supersedeChangedDefinitions(transaction, {
        userId: input.userId,
        accountId: input.accountId,
        messageId: message.id,
        contentHash: message.embeddingContentHash,
        analysisVersion: message.labelAnalysisVersion,
        definitionHash: snapshot.definitionHash,
      });
      return { status: "definitions_changed", nextStepId };
    }

    const definitionsById = new Map(
      snapshot.definitions.map((definition) => [definition.id, definition]),
    );
    if (
      input.decisions.length !== definitionsById.size ||
      new Set(input.decisions.map((decision) => decision.labelId)).size !==
        input.decisions.length ||
      input.decisions.some((decision) => {
        const definition = definitionsById.get(decision.labelId);
        return (
          !definition ||
          definition.definitionVersion !== decision.definitionVersion ||
          !Number.isFinite(decision.confidence) ||
          decision.confidence < 0 ||
          decision.confidence > 100
        );
      })
    ) {
      throw new Error("The message label decisions do not match current definitions.");
    }

    const existingDecisions = snapshot.definitions.length > 0
      ? await transaction
          .select({
            labelId: messageLabelDecisions.labelId,
            userOverride: messageLabelDecisions.userOverride,
          })
          .from(messageLabelDecisions)
          .where(
            and(
              eq(messageLabelDecisions.messageId, message.id),
              inArray(
                messageLabelDecisions.labelId,
                snapshot.definitions.map((definition) => definition.id),
              ),
            ),
          )
      : [];
    const overridesByLabelId = new Map(
      existingDecisions.map((decision) => [
        decision.labelId,
        decision.userOverride,
      ]),
    );

    if (input.decisions.length > 0) {
      await transaction
        .insert(messageLabelDecisions)
        .values(
          input.decisions.map((decision) => ({
            userId: input.userId,
            accountId: input.accountId,
            messageId: message.id,
            labelId: decision.labelId,
            aiDecision: decision.matched
              ? ("applied" as const)
              : ("not_applied" as const),
            confidence: decision.confidence.toFixed(2),
            modelId: input.modelId,
            definitionVersion: decision.definitionVersion,
            analyzedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [
            messageLabelDecisions.messageId,
            messageLabelDecisions.labelId,
          ],
          set: {
            aiDecision: sql`excluded.ai_decision`,
            confidence: sql`excluded.confidence`,
            modelId: input.modelId,
            definitionVersion: sql`excluded.definition_version`,
            analyzedAt: new Date(),
          },
        });
    }

    await transaction
      .delete(messageLabels)
      .where(
        and(
          eq(messageLabels.messageId, message.id),
          eq(messageLabels.source, "ai"),
        ),
      );
    const visibleMemberships = input.decisions.flatMap((decision) => {
      const userOverride = overridesByLabelId.get(decision.labelId) ?? null;
      if (userOverride === "suppressed") return [];
      if (userOverride !== "applied" && !decision.matched) return [];
      return [{
        userId: input.userId,
        accountId: input.accountId,
        messageId: message.id,
        labelId: decision.labelId,
        source: userOverride === "applied" ? ("user" as const) : ("ai" as const),
      }];
    });
    for (const membership of visibleMemberships) {
      await transaction
        .insert(messageLabels)
        .values(membership)
        .onConflictDoUpdate({
          target: [messageLabels.messageId, messageLabels.labelId],
          set: { source: membership.source, updatedAt: new Date() },
        });
    }

    await transaction
      .update(messages)
      .set({
        labelAnalysisState: "complete",
        labelAnalysisDefinitionHash: snapshot.definitionHash,
        labelAnalysisError: null,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id));
    await refreshVisibleThread(transaction, message.threadId);
    const eventId = await insertResolutionEvent(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      messageId: message.id,
      threadId: message.threadId,
      state: "complete",
    });
    return { status: "complete", eventId };
  });
}

export async function failMessageLabelAnalysis(
  input: {
    userId: string;
    accountId: string;
    checkpoint: MessageLabelAnalysisCheckpoint;
    errorCode: string;
  },
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [message] = await transaction
      .select({
        id: messages.id,
        threadId: messages.threadId,
        embeddingContentHash: messages.embeddingContentHash,
        labelAnalysisVersion: messages.labelAnalysisVersion,
        labelAnalysisDefinitionHash: messages.labelAnalysisDefinitionHash,
        labelAnalysisState: messages.labelAnalysisState,
      })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.checkpoint.messageId),
          eq(messages.userId, input.userId),
          eq(messages.accountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !message ||
      !checkpointMatches(message, input.checkpoint) ||
      message.labelAnalysisDefinitionHash !== input.checkpoint.definitionHash ||
      message.labelAnalysisState === "complete" ||
      message.labelAnalysisState === "failed"
    ) {
      return false;
    }
    await transaction
      .update(messages)
      .set({
        labelAnalysisState: "failed",
        labelAnalysisError: input.errorCode,
        labelAnalyzedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(messages.id, message.id));
    await refreshVisibleThread(transaction, message.threadId);
    await insertResolutionEvent(transaction, {
      userId: input.userId,
      accountId: input.accountId,
      messageId: message.id,
      threadId: message.threadId,
      state: "failed",
    });
    return true;
  });
}

export async function getMessageLabelAnalysisCounts(
  accountId: string,
  database: Database = getDatabase(),
): Promise<{
  pending: number;
  running: number;
  complete: number;
  failed: number;
}> {
  const rows = await database
    .select({ state: messages.labelAnalysisState, value: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.accountId, accountId))
    .groupBy(messages.labelAnalysisState);
  const counts = { pending: 0, running: 0, complete: 0, failed: 0 };
  for (const row of rows) counts[row.state] = Number(row.value);
  return counts;
}

export function isMessageLabelAnalysisVisible(
  state: "pending" | "running" | "complete" | "failed",
): boolean {
  return state === "complete" || state === "failed";
}

export const visibleMessageLabelAnalysisStates = ["complete", "failed"] as const;
