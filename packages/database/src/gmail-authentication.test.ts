import assert from "node:assert/strict";
import { test } from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  getReturningGmailAuthenticationAction,
  saveNewGmailConnection,
} from "./repositories";
import { gmailWatchStates, profiles, workflowSteps } from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("returning OAuth repairs a reconnect-required replica without a new initial run", () => {
  assert.equal(
    getReturningGmailAuthenticationAction({
      status: "reconnect_required",
      replicaState: "failed",
      historyCursor: null,
      currentHistoryId: "200",
    }),
    "repair",
  );
});

test("returning OAuth only catches up a ready connected replica when Gmail advanced", () => {
  assert.equal(
    getReturningGmailAuthenticationAction({
      status: "connected",
      replicaState: "ready",
      historyCursor: "100",
      currentHistoryId: "200",
    }),
    "catchup",
  );
  assert.equal(
    getReturningGmailAuthenticationAction({
      status: "connected",
      replicaState: "ready",
      historyCursor: "200",
      currentHistoryId: "200",
    }),
    "none",
  );
});

test(
  "out-of-order Gmail connection saves retain the newest watch and one renewal",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 2, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const providerAccountId = `provider-${uuidv4()}`;
    const olderWatch = {
      topicName: "projects/test/topics/gmail",
      historyId: "100",
      expirationAt: new Date("2030-01-08T10:00:00.000Z"),
      renewedAt: new Date("2030-01-01T10:00:00.000Z"),
    };
    const newerWatch = {
      topicName: "projects/test/topics/gmail",
      historyId: "200",
      expirationAt: new Date("2030-01-08T10:01:00.000Z"),
      renewedAt: new Date("2030-01-01T09:59:00.000Z"),
    };
    const authentication = {
      userId,
      providerAccountId,
      email: `${userId}@example.test`,
      image: null,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      currentHistoryId: "200",
      tokenCiphertext: "encrypted-test-token",
      authenticatedAt: new Date("2030-01-01T10:02:00.000Z"),
      initialHistoryId: "200",
    };

    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Gmail Authentication Test User",
        email: authentication.email,
      });

      const created = await saveNewGmailConnection(
        { ...authentication, watch: olderWatch },
        database,
      );
      const raced = await saveNewGmailConnection(
        { ...authentication, watch: newerWatch },
        database,
      );
      const staleRetry = await saveNewGmailConnection(
        { ...authentication, watch: olderWatch },
        database,
      );

      assert.equal(created.created, true);
      assert.equal(raced.created, false);
      assert.equal(staleRetry.created, false);
      const [storedWatch] = await database
        .select()
        .from(gmailWatchStates)
        .where(eq(gmailWatchStates.accountId, created.id));
      assert.equal(storedWatch?.historyId, newerWatch.historyId);
      assert.equal(
        storedWatch?.expirationAt.toISOString(),
        newerWatch.expirationAt.toISOString(),
      );
      assert.equal(
        storedWatch?.lastRenewedAt.toISOString(),
        newerWatch.renewedAt.toISOString(),
      );

      const renewalSteps = await database
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, created.id),
            eq(workflowSteps.stepType, "gmail.watch.renew"),
          ),
        );
      assert.equal(renewalSteps.length, 1);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
