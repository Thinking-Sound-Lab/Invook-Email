import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  createGmailHistoryContinuationStep,
  highestGmailHistoryCursor,
  applyGmailHistoryBatch,
  markGmailReplicaReady,
  recordGmailPushNotification,
} from "./replica";
import {
  createRepairMailSyncRun,
  dispatchTemporalCommandBatch,
  TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE,
  enqueuePendingGmailHistoryCatchups,
  enqueueWorkflowStep,
  getActiveRepairMailSyncRunContext,
} from "./workflows";
import {
  connectedAccounts,
  gmailReplicaStates,
  profiles,
  temporalCommands,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Gmail pushes without a connected account are acknowledged without storage",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    try {
      const result = await recordGmailPushNotification(
        {
          emailAddress: `${uuidv4()}@example.com`,
          notificationHistoryId: "100",
        },
        database,
      );

      assert.deepEqual(result, { status: "ignored", accountId: null });
    } finally {
      await client.end();
    }
  },
);

test("Gmail notification cursors must be decimal integers", async () => {
  await assert.rejects(
    recordGmailPushNotification({
      emailAddress: "user@example.com",
      notificationHistoryId: "1e3",
    }),
    /history cursor is invalid/,
  );
});

test("duplicate and reordered Gmail notifications retain the highest cursor", () => {
  assert.equal(highestGmailHistoryCursor(null, "100"), "100");
  assert.equal(highestGmailHistoryCursor("150", "150"), "150");
  assert.equal(highestGmailHistoryCursor("150", "140"), "150");
  assert.equal(highestGmailHistoryCursor("150", "160"), "160");
  assert.equal(
    highestGmailHistoryCursor("99999999999999999999", "100000000000000000000"),
    "100000000000000000000",
  );
});

test("each catch-up activation creates one deterministic continuation contract", () => {
  assert.deepEqual(
    createGmailHistoryContinuationStep({
      userId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      sourceStepId: "33333333-3333-4333-8333-333333333333",
      pendingHistoryCursor: "150",
    }),
    {
      userId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      stepType: "gmail.history.catchup",
      payload: { reason: "continuation", pendingHistoryCursor: "150" },
      idempotencyKey:
        "gmail-history-continuation:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333",
    },
  );
});

test(
  "notification admission preserves the highest cursor until an applied range clears it",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const emailAddress = `${accountId}@example.com`;
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
        email: emailAddress,
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        state: "snapshotting",
      });

      const first = await recordGmailPushNotification(
        { emailAddress, notificationHistoryId: "150" },
        database,
      );
      const reordered = await recordGmailPushNotification(
        { emailAddress, notificationHistoryId: "140" },
        database,
      );
      assert.equal(first.status, "queued");
      assert.equal(reordered.status, "coalesced");

      assert.equal(
        await markGmailReplicaReady(
          { userId, accountId, historyCursor: "120" },
          database,
        ),
        true,
      );
      const [readyReplica] = await database
        .select()
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      assert.equal(readyReplica?.pendingHistoryCursor, "150");
      const catchups = await database
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, accountId),
            eq(workflowSteps.stepType, "gmail.history.catchup"),
          ),
        );
      assert.equal(catchups.length, 2);

      const continuationSourceStepId = uuidv4();
      const firstApplied = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "120",
          nextCursor: "130",
          messages: [],
          labelChanges: [],
          deletedMessageIds: [],
          continuationSourceStepId,
        },
        database,
      );
      assert.equal(firstApplied.applied, true);
      assert.equal(firstApplied.pendingHistoryCursor, "150");
      assert.ok(firstApplied.continuationStepId);

      const [continuation] = await database
        .select({
          id: workflowSteps.id,
          idempotencyKey: workflowSteps.idempotencyKey,
          payload: workflowSteps.input,
          status: workflowSteps.status,
        })
        .from(workflowSteps)
        .where(eq(workflowSteps.id, firstApplied.continuationStepId));
      assert.deepEqual(continuation, {
        id: firstApplied.continuationStepId,
        idempotencyKey:
          `gmail-history-continuation:${accountId}:${continuationSourceStepId}`,
        payload: { reason: "continuation", pendingHistoryCursor: "150" },
        status: "queued",
      });
      const continuationOutbox = await database
        .select({ workflowStepId: temporalCommands.workflowStepId })
        .from(temporalCommands)
        .where(eq(temporalCommands.workflowStepId, firstApplied.continuationStepId));
      assert.deepEqual(continuationOutbox, [
        { workflowStepId: firstApplied.continuationStepId },
      ]);

      const secondApplied = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "130",
          nextCursor: "160",
          messages: [],
          labelChanges: [],
          deletedMessageIds: [],
        },
        database,
      );
      assert.equal(secondApplied.applied, true);
      assert.equal(secondApplied.pendingHistoryCursor, null);
      assert.equal(secondApplied.continuationStepId, null);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "repair notifications are reactivated and applied without marking the replica ready",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const emailAddress = `${accountId}@example.com`;
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
        email: emailAddress,
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        state: "repairing",
      });
      const runId = await createRepairMailSyncRun(
        {
          userId,
          accountId,
          startingHistoryCursor: "200",
        },
        database,
      );
      assert.deepEqual(
        await getActiveRepairMailSyncRunContext(accountId, database),
        {
          id: runId,
          startingHistoryCursor: "200",
          status: "queued",
        },
      );

      await recordGmailPushNotification(
        { emailAddress, notificationHistoryId: "250" },
        database,
      );
      assert.equal(await enqueuePendingGmailHistoryCatchups(database), 1);

      const [recoveryStep] = await database
        .select({
          id: workflowSteps.id,
          input: workflowSteps.input,
        })
        .from(workflowSteps)
        .where(
          eq(
            workflowSteps.idempotencyKey,
            `gmail-history-pending-reconciliation:${accountId}:${runId}:250`,
          ),
        );
      assert.ok(recoveryStep?.id);
      assert.deepEqual(recoveryStep.input, {
        reason: "pending_reconciliation",
        pendingHistoryCursor: "250",
      });

      const applied = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "100",
          nextCursor: "260",
          messages: [],
          labelChanges: [],
          deletedMessageIds: [],
          stateAfterApply: "repairing",
        },
        database,
      );
      assert.equal(applied.applied, true);
      assert.equal(applied.pendingHistoryCursor, null);

      const [replica] = await database
        .select({
          state: gmailReplicaStates.state,
          historyCursor: gmailReplicaStates.historyCursor,
          pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor,
        })
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      assert.deepEqual(replica, {
        state: "repairing",
        historyCursor: "260",
        pendingHistoryCursor: null,
      });
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);

test(
  "snapshot notifications are reactivated and applied without completing the snapshot",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const emailAddress = `${accountId}@example.com`;
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
        email: emailAddress,
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        state: "snapshotting",
      });
      await enqueueWorkflowStep(
        {
          userId,
          accountId,
          stepType: "label.message.analyze",
          payload: {},
          idempotencyKey: `bulk-label:${accountId}`,
        },
        database,
      );
      for (
        let index = 0;
        index < TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE;
        index += 1
      ) {
        await enqueueWorkflowStep(
          {
            userId,
            accountId,
            stepType: "label.message.analyze",
            payload: {},
            idempotencyKey: `bulk-label:${accountId}:${index}`,
          },
          database,
        );
      }
      await enqueueWorkflowStep(
        {
          userId,
          accountId,
          stepType: "label.message.analyze",
          payload: { dispatchClass: "live" },
          idempotencyKey: `live-label:${accountId}`,
        },
        database,
      );

      await recordGmailPushNotification(
        { emailAddress, notificationHistoryId: "150" },
        database,
      );
      assert.equal(await enqueuePendingGmailHistoryCatchups(database), 1);

      let dispatchedJobs: Array<{
        stepType: string;
        activityTaskQueue: string;
        payload: Record<string, unknown>;
      }> = [];
      await dispatchTemporalCommandBatch(
        async (jobs) => {
          dispatchedJobs = jobs;
        },
        database,
      );
      assert.equal(
        dispatchedJobs.length,
        TEMPORAL_COMMAND_DISPATCH_BATCH_SIZE,
      );
      assert.equal(dispatchedJobs[0]?.stepType, "gmail.history.catchup");
      const liveLabelIndex = dispatchedJobs.findIndex(
        (job) => job.payload.dispatchClass === "live",
      );
      const bulkLabelIndex = dispatchedJobs.findIndex(
        (job) => job.activityTaskQueue === "mail-label-submit",
      );
      assert.ok(liveLabelIndex >= 0);
      assert.ok(bulkLabelIndex > liveLabelIndex);
      assert.equal(
        dispatchedJobs[liveLabelIndex]?.activityTaskQueue,
        "mail-label-live",
      );

      const [recoveryStep] = await database
        .select({ input: workflowSteps.input })
        .from(workflowSteps)
        .where(
          eq(
            workflowSteps.idempotencyKey,
            `gmail-history-pending-reconciliation:${accountId}:snapshotting:150`,
          ),
        );
      assert.deepEqual(recoveryStep?.input, {
        reason: "pending_reconciliation",
        pendingHistoryCursor: "150",
      });

      const applied = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "100",
          nextCursor: "160",
          messages: [],
          labelChanges: [],
          deletedMessageIds: [],
          stateAfterApply: "snapshotting",
        },
        database,
      );
      assert.equal(applied.applied, true);
      assert.equal(applied.pendingHistoryCursor, null);

      const [replica] = await database
        .select({
          state: gmailReplicaStates.state,
          historyCursor: gmailReplicaStates.historyCursor,
          pendingHistoryCursor: gmailReplicaStates.pendingHistoryCursor,
        })
        .from(gmailReplicaStates)
        .where(eq(gmailReplicaStates.accountId, accountId));
      assert.deepEqual(replica, {
        state: "snapshotting",
        historyCursor: "160",
        pendingHistoryCursor: null,
      });
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
