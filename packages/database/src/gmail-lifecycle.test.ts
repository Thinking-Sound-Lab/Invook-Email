import assert from "node:assert/strict";
import test from "node:test";

import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  mailSyncRuns,
  profiles,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";
import {
  failWorkflowStep,
  markGmailAccountReconnectRequired,
  markWorkflowStepRunning,
} from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "terminal stalled sync fails the run, remaining items, and published workflow steps",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const stalledStepId = uuidv4();
    const remainingStepId = uuidv4();
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
        syncState: { mailSync: "running", indexing: "running", memory: "complete" },
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
        discoveredMessageCount: 2,
        idempotencyKey: `test-run-${runId}`,
      });
      await database.insert(gmailSyncItems).values([
        { runId, providerMessageId: "message-1", status: "running" },
        { runId, providerMessageId: "message-2", status: "queued" },
      ]);
      await database.insert(workflowSteps).values([
        {
          id: stalledStepId,
          runId,
          userId,
          accountId,
          stepType: "gmail.sync.message",
          status: "running",
          input: { runId, providerMessageId: "message-1" },
          idempotencyKey: `test-step-${stalledStepId}`,
        },
        {
          id: remainingStepId,
          runId,
          userId,
          accountId,
          stepType: "gmail.sync.message",
          input: { runId, providerMessageId: "message-2" },
          idempotencyKey: `test-step-${remainingStepId}`,
        },
      ]);

      assert.equal(
        await failWorkflowStep(
          {
            step: {
              id: stalledStepId,
              runId,
              userId,
              accountId,
              stepType: "gmail.sync.message",
              payload: { runId, providerMessageId: "message-1" },
              attempts: 1,
              maxAttempts: 5,
            },
            message: "gmail_workflow_stalled",
            terminal: true,
          },
          database,
        ),
        true,
      );

      const [run] = await database
        .select()
        .from(mailSyncRuns)
        .where(eq(mailSyncRuns.id, runId));
      const items = await database
        .select()
        .from(gmailSyncItems)
        .where(eq(gmailSyncItems.runId, runId))
        .orderBy(asc(gmailSyncItems.providerMessageId));
      const steps = await database
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.runId, runId));
      const [account] = await database
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, accountId));
      const [replica] = await database
        .select()
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));

      assert.equal(run?.status, "failed");
      assert.equal(run?.processedMessageCount, 0);
      assert.equal(run?.failedMessageCount, 2);
      assert.deepEqual(items.map((item) => item.status), ["failed", "failed"]);
      assert.deepEqual(steps.map((step) => step.status), ["failed", "failed"]);
      assert.equal(account?.status, "connected");
      assert.equal(account?.syncState.mailSync, "failed");
      assert.equal(account?.syncState.indexing, "running");
      assert.equal(account?.syncState.memory, "complete");
      assert.equal(replica?.state, "failed");
      assert.deepEqual(
        await markWorkflowStepRunning(remainingStepId, 1, database),
        { shouldExecute: false, result: { status: "inactive" } },
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "permanent authentication failure requires reconnect and cancels remaining Gmail work",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const catchupStepId = uuidv4();
    const renewalStepId = uuidv4();
    const workflowStepIds = [catchupStepId, renewalStepId];
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
        syncState: { mailSync: "complete", indexing: "running", memory: "pending" },
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "200",
        state: "ready",
        readyAt: new Date(),
      });
      await database.insert(workflowSteps).values([
        {
          id: catchupStepId,
          userId,
          accountId,
          stepType: "gmail.history.catchup",
          status: "running",
          input: {},
          idempotencyKey: `test-step-${catchupStepId}`,
        },
        {
          id: renewalStepId,
          userId,
          accountId,
          stepType: "gmail.watch.renew",
          status: "queued",
          input: {},
          idempotencyKey: `test-step-${renewalStepId}`,
        },
      ]);

      assert.equal(
        await markGmailAccountReconnectRequired(
          { accountId, errorCode: "provider_authentication_failed" },
          database,
        ),
        true,
      );

      const [account] = await database
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, accountId));
      const [replica] = await database
        .select()
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      const steps = await database
        .select()
        .from(workflowSteps)
        .where(inArray(workflowSteps.id, workflowStepIds));

      assert.equal(account?.status, "reconnect_required");
      assert.equal(account?.syncState.mailSync, "failed");
      assert.equal(account?.syncState.indexing, "running");
      assert.equal(replica?.state, "failed");
      assert.equal(replica?.lastError, "provider_authentication_failed");
      assert.deepEqual(steps.map((step) => step.status), ["failed", "failed"]);
      assert.deepEqual(
        await markWorkflowStepRunning(renewalStepId, 1, database),
        { shouldExecute: false, result: { status: "inactive" } },
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
