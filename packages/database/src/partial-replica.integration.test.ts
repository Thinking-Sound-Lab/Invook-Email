import assert from "node:assert/strict";
import test from "node:test";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import { queryInvookMailbox } from "./mailbox-query";
import {
  enqueueGmailHistoryCatchup,
  getAiReplyDraftForGmailSave,
  getGmailMessageMutationContext,
  getGmailProviderWriteContext,
} from "./replica";
import {
  createMessageContentHash,
  getMailboxThreadForAgent,
  getMailboxWorkspace,
  getReplyDraftContext,
  listMailboxThreadAttachments,
  searchMailbox,
} from "./repositories";
import {
  accountSecrets,
  connectedAccounts,
  drafts,
  gmailReplicaStates,
  labels,
  messageAttachments,
  messageLabels,
  messages,
  profiles,
  queueOutbox,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";
import { createInitialMailSyncRun } from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

interface PartialReplicaFixture {
  database: Database;
  userId: string;
  otherUserId: string;
  accountId: string;
  threadId: string;
  messageId: string;
  draftId: string;
  gmailLabelId: string;
  initialRunId: string;
}

async function withPartialReplicaFixture(
  run: (fixture: PartialReplicaFixture) => Promise<void>,
): Promise<void> {
  if (!testDatabaseUrl) return;
  const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
  const database = drizzle(client, { schema });
  const userId = uuidv4();
  const otherUserId = uuidv4();
  const accountId = uuidv4();
  const threadId = uuidv4();
  const messageId = uuidv4();
  const draftId = uuidv4();
  const gmailLabelId = uuidv4();
  const sentAt = new Date("2026-08-15T08:00:00.000Z");
  try {
    await database
      .insert(profiles)
      .values([{ id: userId }, { id: otherUserId }]);
    await database.insert(connectedAccounts).values({
      id: accountId,
      userId,
      providerAccountId: `provider-${accountId}`,
      email: "owner@example.com",
      memoryAcknowledgedAt: new Date(),
      syncState: {
        mailSync: "running",
        indexing: "pending",
        memory: "pending",
      },
    });
    await database.insert(accountSecrets).values({
      accountId,
      tokenCiphertext: "stored-encrypted-credential",
    });
    await database.insert(gmailReplicaStates).values({
      accountId,
      initialHistoryId: "100",
      historyCursor: null,
      state: "snapshotting",
    });
    await database.insert(threads).values({
      id: threadId,
      userId,
      accountId,
      providerThreadId: `provider-thread-${threadId}`,
      subject: "Partial synchronization keyword",
      snippet: "A stored message is immediately usable.",
      participants: ["Distinctive Sender <partial-sender@example.com>"],
      latestMessageAt: sentAt,
      messageCount: 1,
    });
    await database.insert(messages).values({
      id: messageId,
      userId,
      accountId,
      threadId,
      providerMessageId: `provider-message-${messageId}`,
      direction: "incoming",
      sender: {
        raw: "Distinctive Sender <partial-sender@example.com>",
        email: "partial-sender@example.com",
      },
      recipients: ["owner@example.com"],
      providerHistoryId: "105",
      internalDate: sentAt,
      headerLines: [
        {
          key: "from",
          line: "From: Distinctive Sender <partial-sender@example.com>",
        },
        {
          key: "message-id",
          line: "Message-ID: <partial-message@example.com>",
        },
      ],
      subject: "Partial synchronization keyword",
      snippet: "A stored message is immediately usable.",
      bodyText: "The synchronization keyword is present in committed mail.",
      embeddingContentHash: createMessageContentHash({
        direction: "incoming",
        sender: {
          raw: "Distinctive Sender <partial-sender@example.com>",
          email: "partial-sender@example.com",
        },
        recipients: ["owner@example.com"],
        subject: "Partial synchronization keyword",
        bodyText: "The synchronization keyword is present in committed mail.",
      }),
      labelAnalysisState: "complete",
      sentAt,
    });
    await database.insert(labels).values({
      id: gmailLabelId,
      userId,
      accountId,
      kind: "gmail",
      providerLabelId: "INBOX",
      name: "Inbox",
      normalizedName: "inbox",
      providerType: "system",
    });
    await database.insert(messageLabels).values({
      userId,
      accountId,
      messageId,
      labelId: gmailLabelId,
      source: "gmail",
    });
    await database.insert(messageAttachments).values({
      userId,
      accountId,
      messageId,
      providerAttachmentId: "provider-attachment",
      filename: "roadmap-attachment.pdf",
      mimeType: "application/pdf",
      size: 128,
    });
    await database.insert(drafts).values({
      id: draftId,
      userId,
      accountId,
      kind: "invook",
      threadId,
      status: "editing",
      generatedText: "Stored draft",
      currentText: "Stored draft",
    });
    const initialRunId = await createInitialMailSyncRun(
      { userId, accountId, startingHistoryCursor: "100" },
      database,
    );

    await run({
      database,
      userId,
      otherUserId,
      accountId,
      threadId,
      messageId,
      draftId,
      gmailLabelId,
      initialRunId,
    });
  } finally {
    await database
      .delete(profiles)
      .where(inArray(profiles.id, [userId, otherUserId]));
    await client.end();
  }
}

test(
  "stored mailbox rows support browsing, ordinary search, and drafts during initial sync",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const {
        database,
        userId,
        otherUserId,
        threadId,
        messageId,
        draftId,
        gmailLabelId,
      } = fixture;
      const missingThreadId = uuidv4();

      const workspace = await getMailboxWorkspace(
        userId,
        { selectedThreadId: threadId },
        database,
      );
      assert.equal(workspace?.account.replicaState, "snapshotting");
      assert.deepEqual(workspace?.threads.map((thread) => thread.id), [threadId]);
      assert.deepEqual(
        workspace?.selectedThread?.messages.map((message) => message.id),
        [messageId],
      );

      const [textResults, metadataResults, attachmentResults] =
        await Promise.all([
          searchMailbox({ userId, query: "synchronization keyword" }, database),
          searchMailbox({ userId, query: "Distinctive Sender" }, database),
          searchMailbox({ userId, query: "roadmap attachment" }, database),
        ]);
      assert.equal(textResults[0]?.messageId, messageId);
      assert.ok(textResults[0]?.matches.includes("full_text"));
      assert.equal(metadataResults[0]?.messageId, messageId);
      assert.ok(metadataResults[0]?.matches.includes("metadata"));
      assert.equal(attachmentResults[0]?.messageId, messageId);
      assert.ok(attachmentResults[0]?.matches.includes("attachment"));
      assert.deepEqual(
        await searchMailbox(
          { userId: otherUserId, query: "synchronization" },
          database,
        ),
        [],
      );

      const structured = await queryInvookMailbox(
        { userId, gmailLabelIds: [gmailLabelId] },
        database,
      );
      assert.equal(structured.status, "available");
      if (structured.status === "available") {
        assert.deepEqual(
          structured.messages.map((message) => message.messageId),
          [messageId],
        );
      }
      const unavailable = await queryInvookMailbox(
        { userId: otherUserId },
        database,
      );
      assert.deepEqual(unavailable, {
        status: "unavailable",
        reason: "mailbox_not_connected",
      });

      assert.equal(
        (await getMailboxThreadForAgent(userId, threadId, database))?.id,
        threadId,
      );
      assert.equal(
        await getMailboxThreadForAgent(otherUserId, threadId, database),
        null,
      );
      assert.equal(
        await getMailboxThreadForAgent(userId, missingThreadId, database),
        null,
      );
      assert.equal(
        (await listMailboxThreadAttachments(userId, threadId, database))[0]?.filename,
        "roadmap-attachment.pdf",
      );
      assert.deepEqual(
        await listMailboxThreadAttachments(otherUserId, threadId, database),
        [],
      );

      assert.equal(
        (await getReplyDraftContext(userId, threadId, database))?.id,
        threadId,
      );
      assert.equal(
        await getReplyDraftContext(otherUserId, threadId, database),
        null,
      );
      assert.equal(
        await getReplyDraftContext(userId, missingThreadId, database),
        null,
      );
      assert.equal(
        (await getAiReplyDraftForGmailSave({ userId, draftId }, database))?.id,
        draftId,
      );
      assert.equal(
        await getAiReplyDraftForGmailSave({ userId: otherUserId, draftId }, database),
        null,
      );
    });
  },
);

test(
  "partial-replica provider contexts require the owned stored resource",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const {
        database,
        userId,
        otherUserId,
        accountId,
        threadId,
        messageId,
      } = fixture;

      const access = await getGmailProviderWriteContext(userId, database);
      assert.deepEqual(access, {
        userId,
        accountId,
        email: "owner@example.com",
        tokenCiphertext: "stored-encrypted-credential",
      });
      assert.equal(
        await getGmailProviderWriteContext(otherUserId, database),
        null,
      );

      const message = await getGmailMessageMutationContext(
        { userId, messageId },
        database,
      );
      assert.equal(message?.accountId, accountId);
      assert.equal(message?.providerMessageId, `provider-message-${messageId}`);
      assert.equal(
        await getGmailMessageMutationContext(
          { userId: otherUserId, messageId },
          database,
        ),
        null,
      );
      assert.equal(
        await getGmailMessageMutationContext(
          { userId, messageId: uuidv4() },
          database,
        ),
        null,
      );
    });
  },
);

test(
  "provider-write reconciliation stays durable and retry-safe during initial sync",
  { skip: !testDatabaseUrl },
  async () => {
    await withPartialReplicaFixture(async (fixture) => {
      const { database, userId, accountId, initialRunId } = fixture;
      const input = {
        userId,
        accountId,
        reason: "provider_write" as const,
        sourceId: "partial-sync-action",
      };

      const firstStepId = await enqueueGmailHistoryCatchup(input, database);
      const retryStepId = await enqueueGmailHistoryCatchup(input, database);
      assert.equal(retryStepId, firstStepId);

      const steps = await database
        .select({
          id: workflowSteps.id,
          runId: workflowSteps.runId,
          stepType: workflowSteps.stepType,
          status: workflowSteps.status,
        })
        .from(workflowSteps)
        .where(eq(workflowSteps.accountId, accountId));
      assert.deepEqual(
        steps.map((step) => step.stepType).sort(),
        ["gmail.history.catchup", "gmail.sync.page"],
      );
      assert.equal(
        steps.find((step) => step.stepType === "gmail.sync.page")?.runId,
        initialRunId,
      );
      assert.equal(
        steps.find((step) => step.id === firstStepId)?.status,
        "queued",
      );

      const outbox = await database
        .select({
          workflowStepId: queueOutbox.workflowStepId,
          queueName: queueOutbox.queueName,
        })
        .from(queueOutbox)
        .where(inArray(queueOutbox.workflowStepId, steps.map((step) => step.id)));
      assert.deepEqual(
        outbox
          .map((entry) => entry.queueName)
          .sort(),
        ["gmail-control", "gmail-pages"],
      );

      const [replica] = await database
        .select({
          state: gmailReplicaStates.state,
          readyAt: gmailReplicaStates.readyAt,
        })
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      assert.deepEqual(replica, { state: "snapshotting", readyAt: null });
    });
  },
);
