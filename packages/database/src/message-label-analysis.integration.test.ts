import assert from "node:assert/strict";
import test from "node:test";

import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  getMailboxThreadDetail,
  listMailboxThreads,
} from "./mailbox-resources";
import {
  beginHistoricalMessageLabelAnalysis,
  beginMessageLabelAnalysis,
  completeHistoricalMessageLabelAnalysis,
  completeMessageLabelAnalysis,
  ensureBuiltInInvookLabels,
  failMessageLabelAnalysis,
  listInvookLabelPreviewCandidates,
  type HistoricalMessageLabelCheckpoint,
  type MessageLabelAnalysisCheckpoint,
} from "./message-label-analysis";
import {
  applyGmailHistoryBatch,
  getGmailDraftResourceForUser,
} from "./replica";
import {
  createInvookLabel,
  updateInvookLabel,
  upsertMailboxMessage,
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
  temporalCommands,
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
  sentAt?: Date;
  isImportant?: boolean;
}): IndexedMessage {
  const sentAt =
    input.sentAt ??
    new Date(
      `2026-08-15T08:00:${input.historyId.padStart(2, "0").slice(-2)}.000Z`,
    );
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
      ...(input.isImportant === false
        ? []
        : [{ providerLabelId: "IMPORTANT", name: "Important" }]),
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

async function queuedHistoricalCheckpoint(
  database: Database,
  labelId: string,
): Promise<HistoricalMessageLabelCheckpoint> {
  const matching = await database
    .select({ input: workflowSteps.input })
    .from(workflowSteps)
    .where(eq(workflowSteps.stepType, "label.message.apply"))
    .orderBy(desc(workflowSteps.createdAt));
  const payload = matching
    .map((row) => row.input)
    .find((input) => input.labelId === labelId);
  assert.ok(payload);
  const { messageId, contentHash, definitionVersion } = payload;
  if (
    typeof messageId !== "string" ||
    typeof contentHash !== "string" ||
    typeof definitionVersion !== "number"
  ) {
    throw new Error("The queued historical-label checkpoint is invalid.");
  }
  return { messageId, contentHash, labelId, definitionVersion };
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
      await database.insert(profiles).values({
        id: userId,
        displayName: "Database Test User",
        email: `${userId}@example.test`,
      });
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

      const initial = await upsertMailboxMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "initial-message",
          providerThreadId: "initial-thread",
          subject: "Weekly travel receipt newsletter",
          ingestionMode: "initial",
          historyId: "100",
          sentAt: new Date(),
        }),
        database,
      );
      assert.equal(initial.analysisQueued, true);

      const [initialStored] = await database
        .select({ state: messages.labelAnalysisState })
        .from(messages)
        .where(eq(messages.id, initial.messageId));
      assert.equal(initialStored?.state, "pending");
      assert.deepEqual((await listMailboxThreads(userId, {}, database))?.threads, []);

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
          activityTaskQueue: temporalCommands.activityTaskQueue,
        })
        .from(temporalCommands)
        .innerJoin(workflowSteps, eq(workflowSteps.id, temporalCommands.workflowStepId))
        .where(eq(workflowSteps.stepType, "label.message.analyze"));
      const initialOutbox = initialSteps.find(
        (step) => step.input.messageId === initial.messageId,
      );
      assert.equal(initialOutbox?.activityTaskQueue, "mail-label-submit");

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
      const [visible, visibleDetail] = await Promise.all([
        listMailboxThreads(userId, {}, database),
        getMailboxThreadDetail(userId, initial.threadId, database),
      ]);
      assert.equal(visible?.threads[0]?.isOthers, false);
      assert.equal(visibleDetail?.thread.messages[0]?.labelAnalysisState, "complete");
      const important = await listMailboxThreads(
        userId,
        { view: "important" },
        database,
      );
      assert.deepEqual(
        important?.threads.map((thread) => thread.id),
        [initial.threadId],
      );

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

      const pendingDraftMessage = await upsertMailboxMessage(
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
      const workspaceWithPendingDraft = await getMailboxThreadDetail(
        userId,
        initial.threadId,
        database,
      );
      assert.deepEqual(workspaceWithPendingDraft?.thread.gmailDrafts, []);
      assert.equal(
        await getGmailDraftResourceForUser({ userId, gmailDraftId }, database),
        null,
      );
      const previewCandidates = await listInvookLabelPreviewCandidates(
        { userId, limit: 100 },
        database,
      );
      assert.deepEqual(
        previewCandidates.map((candidate) => candidate.messageId),
        [initial.messageId],
      );
      assert.equal(
        previewCandidates[0]?.bodyText,
        "Stored body for Weekly travel receipt newsletter",
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
      assert.equal(lateLabel.historicalAnalysis, null);
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
      const historicalStepsBeforeOptIn = await database
        .select({ value: count(workflowSteps.id) })
        .from(workflowSteps)
        .where(eq(workflowSteps.stepType, "label.message.apply"));
      assert.equal(historicalStepsBeforeOptIn[0]?.value, 0);
      const [stillComplete] = await database
        .select({ state: messages.labelAnalysisState })
        .from(messages)
        .where(eq(messages.id, initial.messageId));
      assert.equal(stillComplete?.state, "complete");

      const security = await createInvookLabel(
        {
          userId,
          name: "Security",
          description: "Account security and authentication notices",
          applyToPastDays: 7,
        },
        database,
      );
      assert.ok(security);
      assert.deepEqual(security.historicalAnalysis, {
        windowDays: 7,
        queuedMessageCount: 1,
      });
      const historicalCheckpoint = await queuedHistoricalCheckpoint(
        database,
        security.id,
      );
      assert.equal(historicalCheckpoint.messageId, initial.messageId);
      const historicalReady = await beginHistoricalMessageLabelAnalysis(
        { userId, accountId, checkpoint: historicalCheckpoint },
        database,
      );
      assert.equal(historicalReady.status, "ready");
      if (historicalReady.status !== "ready") return;
      assert.equal(historicalReady.message.bodyText, "Stored body for Weekly travel receipt newsletter");
      const historicalCompleted = await completeHistoricalMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: historicalCheckpoint,
          modelId: "test-classifier",
          decision: {
            labelId: security.id,
            definitionVersion: security.definitionVersion,
            matched: true,
            confidence: 96,
          },
        },
        database,
      );
      assert.equal(historicalCompleted.status, "complete");
      const [securityMembership] = await database
        .select({ source: messageLabels.source })
        .from(messageLabels)
        .where(
          and(
            eq(messageLabels.messageId, initial.messageId),
            eq(messageLabels.labelId, security.id),
          ),
        );
      assert.equal(securityMembership?.source, "ai");
      assert.equal(
        (
          await completeHistoricalMessageLabelAnalysis(
            {
              userId,
              accountId,
              checkpoint: historicalCheckpoint,
              modelId: "test-classifier",
              decision: {
                labelId: security.id,
                definitionVersion: security.definitionVersion,
                matched: true,
                confidence: 96,
              },
            },
            database,
          )
        ).status,
        "current",
      );

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
        .select({ id: messages.id, threadId: messages.threadId })
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
            matched: false,
            confidence: 85,
          })),
        },
        database,
      );
      const historyWorkspace = await listMailboxThreads(userId, {}, database);
      assert.equal(
        historyWorkspace?.threads.find(
          (thread) => thread.id === historyMessage.threadId,
        )
          ?.isOthers ?? false,
        false,
      );

      const othersMessage = await upsertMailboxMessage(
        indexedMessage({
          userId,
          accountId,
          providerMessageId: "others-message",
          providerThreadId: "others-thread",
          subject: "No matching category",
          ingestionMode: "incremental",
          historyId: "104",
          isImportant: false,
        }),
        database,
      );
      const othersCheckpoint = await queuedAnalysisCheckpoint(
        database,
        othersMessage.messageId,
      );
      const othersReady = await beginMessageLabelAnalysis(
        { userId, accountId, checkpoint: othersCheckpoint },
        database,
      );
      assert.equal(othersReady.status, "ready");
      if (othersReady.status !== "ready") return;
      await completeMessageLabelAnalysis(
        {
          userId,
          accountId,
          checkpoint: othersCheckpoint,
          modelId: "test-classifier",
          decisions: othersReady.definitions.map((definition) => ({
            labelId: definition.id,
            definitionVersion: definition.definitionVersion,
            matched: false,
            confidence: 88,
          })),
        },
        database,
      );
      const [othersWorkspace, othersDetail] = await Promise.all([
        listMailboxThreads(userId, {}, database),
        getMailboxThreadDetail(userId, othersMessage.threadId, database),
      ]);
      assert.equal(
        othersWorkspace?.threads.find((thread) => thread.id === othersMessage.threadId)
          ?.isOthers,
        true,
      );
      assert.equal(othersDetail?.thread.messages[0]?.isOthers, true);

      const staleMessage = await upsertMailboxMessage(
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
      await upsertMailboxMessage(
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
      await database.insert(profiles).values({
        id: userId,
        displayName: "Database Test User",
        email: `${userId}@example.test`,
      });
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
      const stored = await upsertMailboxMessage(
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
      const [workspace, detail] = await Promise.all([
        listMailboxThreads(userId, {}, database),
        getMailboxThreadDetail(userId, stored.threadId, database),
      ]);
      assert.equal(workspace?.threads[0]?.hasLabelAnalysisFailure, true);
      assert.equal(workspace?.threads[0]?.isOthers, false);
      assert.equal(detail?.thread.messages[0]?.labelAnalysisState, "failed");
      assert.equal(detail?.thread.messages[0]?.isOthers, false);
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
