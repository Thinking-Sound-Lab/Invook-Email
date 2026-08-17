import assert from "node:assert/strict";
import test from "node:test";

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import * as schema from "./schema";
import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  mailSyncRuns,
  profiles,
  temporalCommands,
  workflowSteps,
} from "./schema";
import {
  GMAIL_SYNC_MESSAGE_BATCH_SIZE,
  recordMailSyncPage,
} from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "mail sync pages admit bounded Temporal message batches atomically",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const providerMessageIds = Array.from(
      { length: GMAIL_SYNC_MESSAGE_BATCH_SIZE * 2 + 3 },
      (_, index) => `provider-message-${index + 1}`,
    );
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
        email: `${accountId}@example.com`,
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        state: "snapshotting",
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "100",
        idempotencyKey: `message-batch-test:${runId}`,
      });

      assert.equal(
        await recordMailSyncPage(
          {
            runId,
            userId,
            accountId,
            pageNumber: 1,
            pageToken: null,
            nextPageToken: null,
            providerMessageIds,
          },
          database,
        ),
        true,
      );

      const items = await database
        .select({ providerMessageId: gmailSyncItems.providerMessageId })
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, runId));
      const batches = await database
        .select({
          idempotencyKey: workflowSteps.idempotencyKey,
          input: workflowSteps.input,
          activityTaskQueue: temporalCommands.activityTaskQueue,
        })
        .from(workflowSteps)
        .innerJoin(
          temporalCommands,
          eq(temporalCommands.workflowStepId, workflowSteps.id),
        )
        .where(eq(workflowSteps.runId, runId))
        .orderBy(asc(workflowSteps.idempotencyKey));

      assert.equal(items.length, providerMessageIds.length);
      assert.deepEqual(
        batches.map((batch) => ({
          idempotencyKey: batch.idempotencyKey,
          activityTaskQueue: batch.activityTaskQueue,
          messageCount: Array.isArray(batch.input.providerMessageIds)
            ? batch.input.providerMessageIds.length
            : 0,
        })),
        [
          {
            idempotencyKey: `gmail-message-batch:${runId}:1:1`,
            activityTaskQueue: "gmail-message-batches",
            messageCount: GMAIL_SYNC_MESSAGE_BATCH_SIZE,
          },
          {
            idempotencyKey: `gmail-message-batch:${runId}:1:2`,
            activityTaskQueue: "gmail-message-batches",
            messageCount: GMAIL_SYNC_MESSAGE_BATCH_SIZE,
          },
          {
            idempotencyKey: `gmail-message-batch:${runId}:1:3`,
            activityTaskQueue: "gmail-message-batches",
            messageCount: 3,
          },
        ],
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
