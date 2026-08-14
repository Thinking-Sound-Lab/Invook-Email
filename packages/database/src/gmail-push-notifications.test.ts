import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  highestGmailHistoryCursor,
  applyGmailHistoryBatch,
  markGmailReplicaReady,
  recordGmailPushNotification,
} from "./replica";
import {
  connectedAccounts,
  gmailReplicaStates,
  profiles,
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

test(
  "notifications during initial sync remain pending through readiness and then clear",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const emailAddress = `${accountId}@example.com`;
    try {
      await database.insert(profiles).values({ id: userId });
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

      const applied = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "120",
          nextCursor: "160",
          messages: [],
          labelChanges: [],
          deletedMessageIds: [],
        },
        database,
      );
      assert.equal(applied.applied, true);
      assert.equal(applied.pendingHistoryCursor, null);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
