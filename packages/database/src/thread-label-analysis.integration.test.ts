import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import {
  ensureBuiltInInvookLabels,
  listInboxThreadMessages,
  setUserThreadLabel,
} from "./thread-label-analysis";
import {
  listMailboxThreads,
} from "./mailbox-resources";
import { replaceGmailMessageLabels } from "./repositories";
import {
  connectedAccounts,
  gmailReplicaStates,
  labels,
  messageLabels,
  messages,
  profiles,
  threadLabelAssignments,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Inbox threads keep exactly one Invook label across manual replacement and Gmail moves",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1 });
    const database = drizzle(client, { schema }) as Database;
    const userId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const inboxMessageId = uuidv4();
    const spamMessageId = uuidv4();
    const sentAt = new Date("2026-08-18T09:00:00.000Z");

    try {
      await database.insert(profiles).values({
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Thread label test",
      });
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.test",
        memoryAcknowledgedAt: sentAt,
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "100",
        state: "ready",
        readyAt: sentAt,
      });
      await ensureBuiltInInvookLabels({ userId, accountId }, database);
      await database.insert(threads).values({
        id: threadId,
        userId,
        accountId,
        providerThreadId: `provider-thread-${threadId}`,
        subject: "Invoice and spam",
        snippet: "Stored Inbox content",
        participants: ["billing@example.test"],
        latestMessageAt: sentAt,
        messageCount: 2,
      });
      await database.insert(messages).values([
        {
          id: inboxMessageId,
          userId,
          accountId,
          threadId,
          providerMessageId: `provider-${inboxMessageId}`,
          direction: "incoming",
          sender: { raw: "Billing <billing@example.test>", email: "billing@example.test" },
          recipients: ["owner@example.test"],
          internalDate: sentAt,
          headerLines: [],
          subject: "Invoice",
          snippet: "Invoice is ready",
          bodyText: "Your invoice is ready.",
          embeddingContentHash: "a".repeat(64),
          sentAt,
        },
        {
          id: spamMessageId,
          userId,
          accountId,
          threadId,
          providerMessageId: `provider-${spamMessageId}`,
          direction: "incoming",
          sender: { raw: "Spam <spam@example.test>", email: "spam@example.test" },
          recipients: ["owner@example.test"],
          internalDate: new Date(sentAt.getTime() - 1_000),
          headerLines: [],
          subject: "Spam",
          snippet: "Spam content",
          bodyText: "This must not reach classification.",
          embeddingContentHash: "b".repeat(64),
          sentAt: new Date(sentAt.getTime() - 1_000),
        },
      ]);
      const gmailLabels = await database
        .insert(labels)
        .values([
          {
            userId,
            accountId,
            kind: "gmail" as const,
            providerLabelId: "INBOX",
            name: "Inbox",
            normalizedName: "inbox",
            providerType: "system" as const,
          },
          {
            userId,
            accountId,
            kind: "gmail" as const,
            providerLabelId: "SPAM",
            name: "Spam",
            normalizedName: "spam",
            providerType: "system" as const,
          },
        ])
        .returning({ id: labels.id, providerLabelId: labels.providerLabelId });
      const inboxLabelId = gmailLabels.find(
        (label) => label.providerLabelId === "INBOX",
      )?.id;
      const spamLabelId = gmailLabels.find(
        (label) => label.providerLabelId === "SPAM",
      )?.id;
      assert.ok(inboxLabelId);
      assert.ok(spamLabelId);
      await database.insert(messageLabels).values([
        { userId, accountId, messageId: inboxMessageId, labelId: inboxLabelId, source: "gmail" },
        { userId, accountId, messageId: spamMessageId, labelId: spamLabelId, source: "gmail" },
      ]);

      assert.deepEqual(
        (await listInboxThreadMessages(threadId, database)).map(({ id }) => id),
        [inboxMessageId],
      );

      const invookLabels = await database
        .select({ id: labels.id, systemKey: labels.systemKey })
        .from(labels)
        .where(and(eq(labels.accountId, accountId), eq(labels.kind, "invook")));
      const importantLabelId = invookLabels.find(
        (label) => label.systemKey === "important",
      )?.id;
      const billingLabelId = invookLabels.find(
        (label) => label.systemKey === "billing",
      )?.id;
      assert.ok(importantLabelId);
      assert.ok(billingLabelId);

      await setUserThreadLabel({ userId, threadId, labelId: importantLabelId }, database);
      await setUserThreadLabel({ userId, threadId, labelId: billingLabelId }, database);
      const assignments = await database
        .select()
        .from(threadLabelAssignments)
        .where(eq(threadLabelAssignments.threadId, threadId));
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]?.labelId, billingLabelId);
      assert.equal(assignments[0]?.assignmentVersion, 2);
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads.map(
          (thread) => [thread.id, thread.invookLabel?.labelId],
        ),
        [[threadId, billingLabelId]],
      );

      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: `provider-${inboxMessageId}`,
          providerHistoryId: "101",
          gmailLabels: [],
        },
        database,
      );
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads,
        [],
      );
      assert.equal(
        (await database
          .select({ labelId: threadLabelAssignments.labelId })
          .from(threadLabelAssignments)
          .where(eq(threadLabelAssignments.threadId, threadId)))[0]?.labelId,
        billingLabelId,
      );

      await replaceGmailMessageLabels(
        {
          userId,
          accountId,
          providerMessageId: `provider-${inboxMessageId}`,
          providerHistoryId: "102",
          gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }],
        },
        database,
      );
      assert.deepEqual(
        (await listMailboxThreads(userId, { view: "all" }, database))?.threads.map(
          (thread) => thread.id,
        ),
        [threadId],
      );
      assert.equal(
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(eq(workflowSteps.stepType, "label.thread.assign"))
          .then((rows) => rows.length),
        0,
      );
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
