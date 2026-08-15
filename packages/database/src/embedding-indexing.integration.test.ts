import assert from "node:assert/strict";
import test from "node:test";

import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  createMessageContentHash,
  finalizeEmbeddingBatchSubmission,
  finalizeEmptyEmbeddingBackfill,
  markEmbeddingBatchSubmitted,
} from "./repositories";
import {
  connectedAccounts,
  embeddingBatchSubmissions,
  gmailReplicaStates,
  messageEmbeddings,
  messages,
  profiles,
  queueOutbox,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const modelId = "test-embedding-model";

test(
  "embedding completion rejects superseded content, queues one continuation, and deduplicates processing",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const submissionStepId = uuidv4();
    const submissionId = uuidv4();
    const firstMessageId = uuidv4();
    const secondMessageId = uuidv4();
    const firstContentHash = createMessageContentHash({
      subject: "First",
      bodyText: "First body",
    });
    const secondContentHash = createMessageContentHash({
      subject: "Second",
      bodyText: "Second body",
    });
    const supersededSecondContentHash = createMessageContentHash({
      subject: "Second updated",
      bodyText: "Second body updated",
    });
    try {
      await database.insert(profiles).values({ id: userId });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "indexing@example.com",
        memoryAcknowledgedAt: new Date(),
        syncState: {
          mailSync: "complete",
          indexing: "running",
          memory: "pending",
        },
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "100",
        state: "ready",
        readyAt: new Date(),
      });
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: `thread-${threadId}`,
        subject: "Indexing",
      });
      await database.insert(messages).values([
        {
          id: firstMessageId,
          userId,
          accountId,
          threadId,
          providerMessageId: `message-${firstMessageId}`,
          direction: "incoming",
          sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
          subject: "First",
          bodyText: "First body",
          embeddingContentHash: firstContentHash,
          internalDate: new Date("2026-08-13T08:00:00.000Z"),
          sentAt: new Date("2026-08-13T08:00:00.000Z"),
        },
        {
          id: secondMessageId,
          userId,
          accountId,
          threadId,
          providerMessageId: `message-${secondMessageId}`,
          direction: "incoming",
          sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
          subject: "Second",
          bodyText: "Second body",
          embeddingContentHash: secondContentHash,
          internalDate: new Date("2026-08-13T09:00:00.000Z"),
          sentAt: new Date("2026-08-13T09:00:00.000Z"),
        },
      ]);
      await database.insert(workflowSteps).values({
        id: submissionStepId,
        userId,
        accountId,
        stepType: "embedding.backfill",
        status: "complete",
        idempotencyKey: `submission-${submissionStepId}`,
      });
      await database.insert(embeddingBatchSubmissions).values({
        id: submissionId,
        workflowStepId: submissionStepId,
        userId,
        accountId,
        providerBatchId: "provider-batch-1",
        inputFileId: "input-file-1",
        modelId,
        dimensions: 1_536,
        indexVersion: 1,
        batchAttempt: 1,
        hasMore: false,
        requestCount: 2,
        manifest: [
          {
            key: firstMessageId,
            messageId: firstMessageId,
            contentHash: firstContentHash,
          },
          {
            key: secondMessageId,
            messageId: secondMessageId,
            contentHash: secondContentHash,
          },
        ],
        status: "submitted",
      });
      await database.insert(messageEmbeddings).values([
        {
          userId,
          accountId,
          messageId: firstMessageId,
          modelId,
          dimensions: 1_536,
          indexVersion: 1,
          contentHash: firstContentHash,
          status: "submitted",
          providerBatchId: "provider-batch-1",
        },
        {
          userId,
          accountId,
          messageId: secondMessageId,
          modelId,
          dimensions: 1_536,
          indexVersion: 1,
          contentHash: secondContentHash,
          status: "submitted",
          providerBatchId: "provider-batch-1",
        },
      ]);
      await database
        .update(messages)
        .set({
          subject: "Second updated",
          bodyText: "Second body updated",
          embeddingContentHash: supersededSecondContentHash,
        })
        .where(eq(messages.id, secondMessageId));

      const embedding = Array<number>(1_536).fill(0);
      embedding[0] = 1;
      const first = await finalizeEmbeddingBatchSubmission(
        {
          submissionId,
          providerState: "completed",
          providerError: null,
          values: [
            {
              messageId: firstMessageId,
              userId,
              contentHash: firstContentHash,
              embedding,
            },
            {
              messageId: secondMessageId,
              userId,
              contentHash: secondContentHash,
              embedding,
            },
          ],
          failedValues: [],
          batchAttemptLimit: 3,
        },
        database,
      );
      await markEmbeddingBatchSubmitted(
        {
          accountId,
          modelId,
          dimensions: 1_536,
          indexVersion: 1,
          providerBatchId: "provider-batch-1",
          messages: [
            { messageId: firstMessageId, userId, contentHash: firstContentHash },
          ],
        },
        database,
      );
      const duplicate = await finalizeEmbeddingBatchSubmission(
        {
          submissionId,
          providerState: "completed",
          providerError: null,
          values: [],
          failedValues: [],
          batchAttemptLimit: 3,
        },
        database,
      );

      assert.equal(first.stage, "running");
      assert.equal(first.savedCount, 1);
      assert.equal(first.incompleteMessageCount, 1);
      const continuationJobId = first.continuationJobId;
      assert.ok(continuationJobId);
      assert.equal(duplicate.alreadyFinalized, true);
      const [savedEmbedding] = await database
        .select({ status: messageEmbeddings.status })
        .from(messageEmbeddings)
        .where(eq(messageEmbeddings.messageId, firstMessageId))
        .limit(1);
      assert.equal(savedEmbedding?.status, "complete");
      const [continuations] = await database
        .select({ value: count(workflowSteps.id) })
        .from(workflowSteps)
        .where(
          eq(
            workflowSteps.idempotencyKey,
            "embedding.backfill.continue:next:provider-batch-1",
          ),
        );
      const [outboxEntries] = await database
        .select({ value: count(queueOutbox.id) })
        .from(queueOutbox)
        .where(eq(queueOutbox.workflowStepId, continuationJobId));
      assert.equal(continuations?.value, 1);
      assert.equal(outboxEntries?.value, 1);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "an empty ready mailbox reaches complete from durable counts",
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
        email: "empty@example.com",
        memoryAcknowledgedAt: new Date(),
        syncState: {
          mailSync: "complete",
          indexing: "running",
          memory: "pending",
        },
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "200",
        historyCursor: "200",
        state: "ready",
        readyAt: new Date(),
      });

      assert.deepEqual(
        await finalizeEmptyEmbeddingBackfill(
          { accountId, modelId, indexVersion: 1 },
          database,
        ),
        { stage: "complete", incompleteMessageCount: 0 },
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
