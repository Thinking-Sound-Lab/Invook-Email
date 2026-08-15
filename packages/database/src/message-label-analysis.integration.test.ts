import assert from "node:assert/strict";
import test from "node:test";

import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  beginMessageLabelAnalysis,
  completeMessageLabelAnalysis,
  ensureBuiltInInvookLabels,
  failMessageLabelAnalysis,
  type MessageLabelAnalysisCheckpoint,
} from "./message-label-analysis";
import {
  applyGmailHistoryBatch,
  getGmailDraftResourceForUser,
} from "./replica";
import {
  createInvookLabel,
  getMailboxWorkspace,
  updateInvookLabel,
  upsertIndexedMessage,
} from "./repositories";
import {
  connectedAccounts,
  drafts,
  gmailReplicaStates,
  labels,
  mailboxChangeEvents,
  messageLabelDecisions,
  messageLabels,
  messages,
  profiles,
  queueOutbox,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";
import type { IndexedMessage } from "./types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function indexedMessage(input: {
  userId: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  ingestionMode: "initial" | "incremental";
  historyId: string;
}): IndexedMessage {
  const sentAt = new Date(`2026-08-15T08:00:${input.historyId.padStart(2, "0").slice(-2)}.000Z`);
  return {
    userId: input.userId,
    accountId: input.accountId,
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
    subject: input.subject,
    snippet: input.subject,
    participants: ["Sender <sender@example.com>"],
    gmailLabels: [
      { providerLabelId: "INBOX", name: "Inbox" },
      { providerLabelId: "IMPORTANT", name: "Important" },
    ],
    providerHistoryId: input.historyId,
    internalDate: sentAt,
    sizeEstimate: 256,
    headerLines: [{ key: "subject", line: `Subject: ${input.subject}` }],
    sentAt,
    direction: "incoming",
    sender: {
      raw: "Sender <sender@example.com>",
      email: "sender@example.com",
    },
    recipients: ["owner@example.com"],
    bodyText: `Stored body for ${input.subject}`,
    bodyHtml: null,
    rawObject: null,
    isMemoryEligible: false,
    ingestionMode: input.ingestionMode,
    memoryContactEmails: [],
    attachments: [],
  };
}

async function queuedAnalysisCheckpoint(
  database: Database,
  messageId: string,
): Promise<MessageLabelAnalysisCheckpoint> {
  const matching = await database
    .select({ input: workflowSteps.input })
    .from(workflowSteps)
    .where(eq(workflowSteps.stepType, "label.message.analyze"))
    .orderBy(desc(workflowSteps.createdAt));
  const payload = matching
    .map((row) => row.input)
    .find((input) => input.messageId === messageId);
  assert.ok(payload);
  const { contentHash, analysisVersion, definitionHash } = payload;
  if (
    typeof contentHash !== "string" ||
    typeof analysisVersion !== "number" ||
    typeof definitionHash !== "string"
  ) {
    throw new Error("The queued label-analysis checkpoint is invalid.");
  }
  return {
    messageId,
    contentHash,
    analysisVersion,
    definitionHash,
  };
}

test(
  "initial and history ingestion share durable per-message analysis with atomic visibility and stale protection",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    try {
      await database.insert(profiles).values({ id: userId });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.com",
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "100",
        state: "ready",
        readyAt: new Date(),
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      const travel = await createInvookLabel(
        { userId, name: "Travel", description: "Travel plans" },
        database,
      );
      const receipts = await createInvookLabel(
        { userId, name: "Receipts", description: "Purchase receipts" },
        database,
      );
      assert.ok(travel);
      assert.ok(receipts);

      const initial = await upsertIndexedMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "initial-message",
          providerThreadId: "initial-thread",
          subject: "Weekly travel receipt newsletter",
          ingestionMode: "initial",
          historyId: "100",
        }),
        database,
      );
      assert.equal(initial.analysisQueued, true);

      const [initialStored] = await database
        .select({ state: messages.labelAnalysisState })
        .from(messages)
        .where(eq(messages.id, initial.messageId));
      assert.equal(initialStored?.state, "pending");
      assert.deepEqual((await getMailboxWorkspace(userId, {}, database))?.threads, []);

      const initialCheckpoint = await queuedAnalysisCheckpoint(
        database,
        initial.messageId,
      );
      assert.deepEqual(
        await beginMessageLabelAnalysis(
          { userId: uuidv4(), accountId, checkpoint: initialCheckpoint },
          database,
        ),
        { status: "missing" },
      );
      const initialSteps = await database
        .select({
          id: workflowSteps.id,
          input: workflowSteps.input,
          queueName: queueOutbox.queueName,
        })
        .from(queueOutbox)
        .innerJoin(workflowSteps, eq(workflowSteps.id, queueOutbox.workflowStepId))
        .where(eq(workflowSteps.stepType, "label.message.analyze"));
      const initialOutbox = initialSteps.find(
        (step) => step.input.messageId === initial.messageId,
      );
      assert.equal(initialOutbox?.queueName, "mail-label-submit");

      const initialReady = await beginMessageLabelAnalysis(
        { userId, accountId, checkpoint: initialCheckpoint },
        database,
      );
      assert.equal(initialReady.status, "ready");
      if (initialReady.status !== "ready") return;
      const newsletter = initialReady.definitions.find(
        (definition) => definition.name === "Newsletter",
      );
      assert.ok(newsletter);
      assert.deepEqual(
        new Set(initialReady.definitions.map((definition) => definition.id)),
        new Set([newsletter.id, travel.id, receipts.id]),
      );

      const eventsBefore = await database
        .select({ value: count(mailboxChangeEvents.id) })
        .from(mailboxChangeEvents)
        .where(eq(mailboxChangeEvents.accountId, accountId));
      const completed = await completeMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: initialCheckpoint,
          modelId: "test-classifier",
          decisions: initialReady.definitions.map((definition) => ({
            labelId: definition.id,
            definitionVersion: definition.definitionVersion,
            matched: true,
            confidence: 90,
          })),
        },
        database,
      );
      assert.equal(completed.status, "complete");

      const [resolvedMessage] = await database
        .select({ state: messages.labelAnalysisState })
        .from(messages)
        .where(eq(messages.id, initial.messageId));
      const decisions = await database
        .select({ labelId: messageLabelDecisions.labelId })
        .from(messageLabelDecisions)
        .where(eq(messageLabelDecisions.messageId, initial.messageId));
      const memberships = await database
        .select({ source: messageLabels.source, providerLabelId: labels.providerLabelId })
        .from(messageLabels)
        .innerJoin(labels, eq(labels.id, messageLabels.labelId))
        .where(eq(messageLabels.messageId, initial.messageId));
      const eventsAfter = await database
        .select({ value: count(mailboxChangeEvents.id) })
        .from(mailboxChangeEvents)
        .where(eq(mailboxChangeEvents.accountId, accountId));
      assert.equal(resolvedMessage?.state, "complete");
      assert.equal(decisions.length, 3);
      assert.equal(memberships.filter((membership) => membership.source === "ai").length, 3);
      assert.ok(
        memberships.some(
          (membership) =>
            membership.source === "gmail" &&
            membership.providerLabelId === "IMPORTANT",
        ),
      );
      assert.equal(eventsAfter[0]?.value, (eventsBefore[0]?.value ?? 0) + 1);
      const visible = await getMailboxWorkspace(
        userId,
        { selectedThreadId: initial.threadId },
        database,
      );
      assert.equal(visible?.threads[0]?.isOthers, false);
      assert.equal(visible?.selectedThread?.messages[0]?.labelAnalysisState, "complete");

      const retry = await completeMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: initialCheckpoint,
          modelId: "test-classifier",
          decisions: initialReady.definitions.map((definition) => ({
            labelId: definition.id,
            definitionVersion: definition.definitionVersion,
            matched: true,
            confidence: 90,
          })),
        },
        database,
      );
      assert.equal(retry.status, "current");
      const eventsAfterRetry = await database
        .select({ value: count(mailboxChangeEvents.id) })
        .from(mailboxChangeEvents)
        .where(eq(mailboxChangeEvents.accountId, accountId));
      assert.deepEqual(eventsAfterRetry, eventsAfter);

      const pendingDraftMessage = await upsertIndexedMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "pending-draft-message",
          providerThreadId: "initial-thread",
          subject: "Pending Gmail draft",
          ingestionMode: "incremental",
          historyId: "100",
        }),
        database,
      );
      const gmailDraftId = uuidv4();
      await database.insert(drafts).values({
        id: gmailDraftId,
        userId,
        accountId,
        kind: "gmail",
        messageId: pendingDraftMessage.messageId,
        providerDraftId: "provider-draft",
        providerMessageId: "pending-draft-message",
        providerThreadId: "initial-thread",
        status: "editing",
      });
      const workspaceWithPendingDraft = await getMailboxWorkspace(
        userId,
        { selectedThreadId: initial.threadId },
        database,
      );
      assert.deepEqual(workspaceWithPendingDraft?.selectedThread?.gmailDrafts, []);
      assert.equal(
        await getGmailDraftResourceForUser({ userId, gmailDraftId }, database),
        null,
      );

      const stepCountBeforeDefinitionChange = await database
        .select({ value: count(workflowSteps.id) })
        .from(workflowSteps)
        .where(eq(workflowSteps.stepType, "label.message.analyze"));
      const lateLabel = await createInvookLabel(
        { userId, name: "Late", description: "Future mail only" },
        database,
      );
      assert.ok(lateLabel);
      const updatedLateLabel = await updateInvookLabel(
        {
          userId,
          labelId: lateLabel.id,
          name: "Late updated",
          description: "Still future mail only",
        },
        database,
      );
      assert.equal(updatedLateLabel?.definitionVersion, 2);
      const stepCountAfterDefinitionChange = await database
        .select({ value: count(workflowSteps.id) })
        .from(workflowSteps)
        .where(eq(workflowSteps.stepType, "label.message.analyze"));
      assert.deepEqual(stepCountAfterDefinitionChange, stepCountBeforeDefinitionChange);
      const [stillComplete] = await database
        .select({ state: messages.labelAnalysisState })
        .from(messages)
        .where(eq(messages.id, initial.messageId));
      assert.equal(stillComplete?.state, "complete");

      const historyResult = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "100",
          nextCursor: "101",
          messages: [
            indexedMessage({
              userId,
              accountId,
              providerMessageId: "history-message",
              providerThreadId: "history-thread",
              subject: "Custom-only message",
              ingestionMode: "incremental",
              historyId: "101",
            }),
          ],
          labelChanges: [],
          deletedMessageIds: [],
        },
        database,
      );
      assert.equal(historyResult.applied, true);
      const [historyMessage] = await database
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.providerMessageId, "history-message"));
      assert.ok(historyMessage);
      const historyCheckpoint = await queuedAnalysisCheckpoint(
        database,
        historyMessage.id,
      );
      const historyReady = await beginMessageLabelAnalysis(
        { userId, accountId, checkpoint: historyCheckpoint },
        database,
      );
      assert.equal(historyReady.status, "ready");
      if (historyReady.status !== "ready") return;
      await completeMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: historyCheckpoint,
          modelId: "test-classifier",
          decisions: historyReady.definitions.map((definition) => ({
            labelId: definition.id,
            definitionVersion: definition.definitionVersion,
            matched: definition.id === travel.id,
            confidence: 85,
          })),
        },
        database,
      );
      const historyWorkspace = await getMailboxWorkspace(userId, {}, database);
      assert.ok(historyWorkspace?.threads.some((thread) => thread.isOthers));

      const staleMessage = await upsertIndexedMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "stale-message",
          providerThreadId: "stale-thread",
          subject: "Before definition edit",
          ingestionMode: "incremental",
          historyId: "102",
        }),
        database,
      );
      const staleCheckpoint = await queuedAnalysisCheckpoint(
        database,
        staleMessage.messageId,
      );
      const staleReady = await beginMessageLabelAnalysis(
        { userId, accountId, checkpoint: staleCheckpoint },
        database,
      );
      assert.equal(staleReady.status, "ready");
      if (staleReady.status !== "ready") return;
      await updateInvookLabel(
        {
          userId,
          labelId: travel.id,
          name: "Travel",
          description: "Updated travel definition",
        },
        database,
      );
      const staleDefinitionResult = await completeMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: staleCheckpoint,
          modelId: "test-classifier",
          decisions: staleReady.definitions.map((definition) => ({
            labelId: definition.id,
            definitionVersion: definition.definitionVersion,
            matched: true,
            confidence: 80,
          })),
        },
        database,
      );
      assert.equal(staleDefinitionResult.status, "definitions_changed");
      assert.equal(
        await failMessageLabelAnalysis(
          {
            userId,
            accountId,
            checkpoint: staleCheckpoint,
            errorCode: "label_analysis_failed",
          },
          database,
        ),
        false,
      );
      const staleDecisions = await database
        .select({ id: messageLabelDecisions.messageId })
        .from(messageLabelDecisions)
        .where(eq(messageLabelDecisions.messageId, staleMessage.messageId));
      assert.deepEqual(staleDecisions, []);

      const supersedingCheckpoint = await queuedAnalysisCheckpoint(
        database,
        staleMessage.messageId,
      );
      const supersedingReady = await beginMessageLabelAnalysis(
        { userId, accountId, checkpoint: supersedingCheckpoint },
        database,
      );
      assert.equal(supersedingReady.status, "ready");
      await upsertIndexedMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "stale-message",
          providerThreadId: "stale-thread",
          subject: "After content edit",
          ingestionMode: "incremental",
          historyId: "103",
        }),
        database,
      );
      const staleContentResult = await completeMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: supersedingCheckpoint,
          modelId: "test-classifier",
          decisions:
            supersedingReady.status === "ready"
              ? supersedingReady.definitions.map((definition) => ({
                  labelId: definition.id,
                  definitionVersion: definition.definitionVersion,
                  matched: true,
                  confidence: 80,
                }))
              : [],
        },
        database,
      );
      assert.equal(staleContentResult.status, "superseded");
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "terminal model failure becomes visible without AI decisions or derived Others",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    try {
      await database.insert(profiles).values({ id: userId });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.com",
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "200",
        historyCursor: "200",
        state: "ready",
        readyAt: new Date(),
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      const stored = await upsertIndexedMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "failed-message",
          providerThreadId: "failed-thread",
          subject: "Model unavailable",
          ingestionMode: "initial",
          historyId: "200",
        }),
        database,
      );
      const checkpoint = await queuedAnalysisCheckpoint(database, stored.messageId);
      assert.equal(
        await failMessageLabelAnalysis(
          {
            userId,
            accountId,
            checkpoint: {
              messageId: checkpoint.messageId,
              contentHash: checkpoint.contentHash,
              analysisVersion: checkpoint.analysisVersion,
              definitionHash: checkpoint.definitionHash,
            },
            errorCode: "label_analysis_model_unavailable",
          },
          database,
        ),
        true,
      );
      const workspace = await getMailboxWorkspace(
        userId,
        { selectedThreadId: stored.threadId },
        database,
      );
      assert.equal(workspace?.threads[0]?.hasLabelAnalysisFailure, true);
      assert.equal(workspace?.threads[0]?.isOthers, false);
      assert.equal(workspace?.selectedThread?.messages[0]?.labelAnalysisState, "failed");
      assert.equal(workspace?.selectedThread?.messages[0]?.isOthers, false);
      const decisions = await database
        .select({ labelId: messageLabelDecisions.labelId })
        .from(messageLabelDecisions)
        .where(eq(messageLabelDecisions.messageId, stored.messageId));
      assert.deepEqual(decisions, []);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
