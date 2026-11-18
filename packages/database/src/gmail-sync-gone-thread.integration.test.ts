import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  deleteIndexedMessagesForProviderThread,
  getIndexedMessageIds,
} from "./repositories";
import * as schema from "./schema";
import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  mailSyncRuns,
  messages,
  profiles,
  threads,
} from "./schema";
import { getMailSyncRunProviderMessageIds } from "./workflows";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "a Gmail 404 during ingest drops local messages a repair finalize would otherwise keep",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const goneThreadId = uuidv4();
    const keptThreadId = uuidv4();
    const goneProviderThreadId = `provider-thread-${goneThreadId}`;
    const keptProviderThreadId = `provider-thread-${keptThreadId}`;
    const goneProviderMessageId = `provider-message-${goneThreadId}`;
    const keptProviderMessageId = `provider-message-${keptThreadId}`;
    const sentAt = new Date("2026-11-18T10:00:00.000Z");
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Gone thread test",
        email: `${userId}@example.test`,
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: `${accountId}@example.com`,
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "200",
        state: "repairing",
      });
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        runType: "repair",
        status: "running",
        startingHistoryCursor: "200",
        idempotencyKey: `gone-thread-test:${runId}`,
      });
      await database.insert(threads).values([
        {
          id: goneThreadId,
          userId,
          accountId,
          providerThreadId: goneProviderThreadId,
          subject: "Permanently deleted in Gmail",
          snippet: "This conversation should leave the replica.",
          participants: ["sender@example.test"],
          latestMessageAt: sentAt,
          messageCount: 1,
        },
        {
          id: keptThreadId,
          userId,
          accountId,
          providerThreadId: keptProviderThreadId,
          subject: "Still in Gmail",
          snippet: "This conversation stays.",
          participants: ["sender@example.test"],
          latestMessageAt: sentAt,
          messageCount: 1,
        },
      ]);
      await database.insert(messages).values([
        {
          userId,
          accountId,
          threadId: goneThreadId,
          providerMessageId: goneProviderMessageId,
          direction: "incoming",
          sender: { raw: "sender@example.test", email: "sender@example.test" },
          recipients: [`${accountId}@example.com`],
          providerHistoryId: "150",
          internalDate: sentAt,
          subject: "Permanently deleted in Gmail",
          snippet: "This conversation should leave the replica.",
          bodyText: "Deleted in Gmail after the repair walk listed it.",
          sentAt,
        },
        {
          userId,
          accountId,
          threadId: keptThreadId,
          providerMessageId: keptProviderMessageId,
          direction: "incoming",
          sender: { raw: "sender@example.test", email: "sender@example.test" },
          recipients: [`${accountId}@example.com`],
          providerHistoryId: "160",
          internalDate: sentAt,
          subject: "Still in Gmail",
          snippet: "This conversation stays.",
          bodyText: "Still present at the provider.",
          sentAt,
        },
      ]);
      await database.insert(gmailSyncItems).values([
        { runId, providerThreadId: goneProviderThreadId, status: "running" },
        { runId, providerThreadId: keptProviderThreadId, status: "running" },
      ]);

      // Completing the listed item without deleting would leave these rows in
      // the provider set repair finalize uses to decide what to keep.
      assert.deepEqual(
        new Set(
          await getMailSyncRunProviderMessageIds(
            { runId, accountId },
            database,
          ),
        ),
        new Set([goneProviderMessageId, keptProviderMessageId]),
      );

      const deleted = await deleteIndexedMessagesForProviderThread(
        {
          accountId,
          providerThreadId: goneProviderThreadId,
        },
        database,
      );
      assert.equal(deleted.threadId, goneThreadId);
      assert.deepEqual(deleted.deletedProviderMessageIds, [
        goneProviderMessageId,
      ]);

      assert.deepEqual(
        await database
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, goneThreadId)),
        [],
      );
      assert.deepEqual(
        await getIndexedMessageIds(accountId, database),
        [keptProviderMessageId],
      );
      assert.deepEqual(
        await getMailSyncRunProviderMessageIds({ runId, accountId }, database),
        [keptProviderMessageId],
      );

      const secondPass = await deleteIndexedMessagesForProviderThread(
        {
          accountId,
          providerThreadId: goneProviderThreadId,
        },
        database,
      );
      assert.deepEqual(secondPass, {
        threadId: null,
        deletedProviderMessageIds: [],
      });
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
