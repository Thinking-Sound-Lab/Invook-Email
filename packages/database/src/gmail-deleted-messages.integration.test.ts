import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { applyGmailHistoryBatch } from "./replica";
import { upsertMailboxThreadMessages } from "./repositories";
import {
  connectedAccounts,
  gmailReplicaStates,
  gmailSyncItems,
  labels,
  mailSyncRuns,
  messages,
  profiles,
  threads,
} from "./schema";
import * as schema from "./schema";
import { ensureBuiltInInvookLabels } from "./thread-label-analysis";
import type { IndexedMessage } from "./types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "a stale thread snapshot cannot resurrect a message live history already deleted",
  { skip: !testDatabaseUrl, timeout: 15_000 },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const accountId = uuidv4();
    const runId = uuidv4();
    const threadId = uuidv4();
    const keptRowId = uuidv4();
    const deletedRowId = uuidv4();
    const providerThreadId = `provider-thread-${threadId}`;
    const keptMessageId = "kept-message";
    const deletedMessageId = "deleted-message";
    const sentAt = new Date("2026-10-20T11:00:00.000Z");
    const snapshotMessage = (providerMessageId: string): IndexedMessage => ({
      userId,
      accountId,
      providerThreadId,
      providerMessageId,
      subject: "Deleted-message race",
      snippet: "Body",
      participants: ["sender@example.test"],
      gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
      providerHistoryId: "120",
      internalDate: sentAt,
      sizeEstimate: 128,
      headerLines: [],
      sentAt,
      direction: "incoming",
      sender: { raw: "sender@example.test", email: "sender@example.test" },
      recipients: [`${accountId}@example.test`],
      bodyText: "Body",
      bodyHtml: null,
      ingestionMode: "initial",
      attachments: [],
    });

    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Deleted message race",
        email: `${userId}@example.test`,
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: accountId,
        email: `${accountId}@example.test`,
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "100",
        state: "snapshotting",
      });
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId,
        subject: "Deleted-message race",
        snippet: "Body",
        participants: ["sender@example.test"],
        latestMessageAt: sentAt,
        messageCount: 2,
      });
      await database.insert(messages).values([
        {
          id: keptRowId,
          userId,
          accountId,
          threadId,
          providerMessageId: keptMessageId,
          direction: "incoming",
          sender: { raw: "sender@example.test", email: "sender@example.test" },
          recipients: [`${accountId}@example.test`],
          providerHistoryId: "120",
          internalDate: sentAt,
          sentAt,
          subject: "Deleted-message race",
          snippet: "Body",
          bodyText: "Body",
        },
        {
          id: deletedRowId,
          userId,
          accountId,
          threadId,
          providerMessageId: deletedMessageId,
          direction: "incoming",
          sender: { raw: "sender@example.test", email: "sender@example.test" },
          recipients: [`${accountId}@example.test`],
          providerHistoryId: "120",
          internalDate: sentAt,
          sentAt,
          subject: "Deleted-message race",
          snippet: "Body",
          bodyText: "Body",
        },
      ]);
      await database.insert(mailSyncRuns).values({
        id: runId,
        userId,
        accountId,
        status: "running",
        startingHistoryCursor: "100",
        discoveredThreadCount: 1,
        idempotencyKey: `deleted-message-race:${runId}`,
      });
      await database.insert(gmailSyncItems).values({
        runId,
        providerThreadId,
        status: "running",
      });
      await database.insert(labels).values({
        userId,
        accountId,
        kind: "gmail",
        providerLabelId: "INBOX",
        name: "Inbox",
        normalizedName: "inbox",
        description: "",
        providerType: "system",
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);

      const deleted = await applyGmailHistoryBatch(
        {
          userId,
          accountId,
          expectedCursor: "100",
          nextCursor: "150",
          messages: [],
          labelChanges: [],
          deletedMessageIds: [
            {
              providerMessageId: deletedMessageId,
              providerHistoryId: "150",
              tombstone: true,
            },
          ],
          stateAfterApply: "snapshotting",
        },
        database,
      );
      assert.equal(deleted.applied, true);
      assert.equal(
        (
          await database
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.accountId, accountId),
                eq(messages.providerMessageId, deletedMessageId),
              ),
            )
        ).length,
        0,
      );

      await upsertMailboxThreadMessages(
        {
          messages: [
            snapshotMessage(keptMessageId),
            snapshotMessage(deletedMessageId),
          ],
          activeRunId: runId,
        },
        database,
      );

      const stored = await database
        .select({ providerMessageId: messages.providerMessageId })
        .from(messages)
        .where(eq(messages.accountId, accountId));
      assert.deepEqual(
        stored.map((row) => row.providerMessageId).sort(),
        [keptMessageId],
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
