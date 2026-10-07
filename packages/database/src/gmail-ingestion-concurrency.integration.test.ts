import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import type { Database } from "./client";
import { InactiveMailSyncRunError, upsertMailboxThreadMessages } from "./repositories";
import * as schema from "./schema";
import { ensureBuiltInInvookLabels } from "./thread-label-analysis";
import type { IndexedMessage } from "./types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

interface IngestionFixture {
  userId: string;
  accountId: string;
  runId: string;
  providerThreadIds: string[];
  message: (providerThreadId: string) => IndexedMessage;
}

async function createIngestionFixture(database: Database): Promise<IngestionFixture> {
  const userId = uuidv4();
  const accountId = uuidv4();
  const runId = uuidv4();
  const providerThreadIds = [uuidv4(), uuidv4()];
  const sentAt = new Date();
  await database.insert(schema.profiles).values({
    id: userId, displayName: "Ingestion concurrency test", email: `${userId}@example.test`,
  });
  await database.insert(schema.connectedAccounts).values({
    id: accountId, userId, providerAccountId: accountId, email: `${accountId}@example.test`,
  });
  await database.insert(schema.mailSyncRuns).values({
    id: runId, userId, accountId, status: "running", startingHistoryCursor: "100",
    discoveredThreadCount: providerThreadIds.length, idempotencyKey: `ingestion-test:${runId}`,
  });
  await database.insert(schema.gmailSyncItems).values(providerThreadIds.map((providerThreadId) => ({
    runId, providerThreadId, status: "running" as const,
  })));
  await database.insert(schema.labels).values({
    userId, accountId, kind: "gmail", providerLabelId: "INBOX",
    name: "Inbox", normalizedName: "inbox", description: "", providerType: "system",
  });
  await ensureBuiltInInvookLabels({ userId, accountId }, database);
  return {
    userId, accountId, runId, providerThreadIds,
    message: (providerThreadId): IndexedMessage => ({
      userId, accountId, providerThreadId, providerMessageId: `message-${providerThreadId}`,
      subject: "Concurrency test", snippet: "Test body", participants: ["sender@example.test"],
      gmailLabels: [{ providerLabelId: "INBOX", name: "Inbox" }], providerHistoryId: "101",
      internalDate: sentAt, sizeEstimate: 128, headerLines: [], sentAt, direction: "incoming",
      sender: { raw: "sender@example.test", email: "sender@example.test" },
      recipients: [`${accountId}@example.test`], bodyText: "Test body", bodyHtml: null,
      ingestionMode: "initial", attachments: [],
    }),
  };
}

test("an unrelated thread can commit while another thread and its unchanged Gmail label are locked", {
  skip: !testDatabaseUrl, timeout: 15_000,
}, async () => {
  if (!testDatabaseUrl) return;
  let resolveBlocked: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { resolveBlocked = resolve; });
  const firstClient = postgres(testDatabaseUrl, {
    max: 1, prepare: false,
    debug: (_connection, query) => {
      if (query.includes("pg_advisory_xact_lock")) resolveBlocked?.();
    },
  });
  const secondClient = postgres(testDatabaseUrl, {
    max: 1, prepare: false, connection: { statement_timeout: 3000 },
  });
  const controlClient = postgres(testDatabaseUrl, { max: 1, prepare: false });
  const firstDatabase = drizzle(firstClient, { schema });
  const secondDatabase = drizzle(secondClient, { schema });
  const controlDatabase = drizzle(controlClient, { schema });
  const fixture = await createIngestionFixture(controlDatabase);
  const [firstThreadId, secondThreadId] = fixture.providerThreadIds;
  assert.ok(firstThreadId && secondThreadId);
  const control = await controlClient.reserve();
  let firstIngestion: ReturnType<typeof upsertMailboxThreadMessages> | undefined;
  try {
    await control`begin`;
    await control`select pg_advisory_xact_lock(hashtextextended(${`${fixture.accountId}:${firstThreadId}`}, 0))`;
    // This lock permits FK references but rejects an unnecessary label update.
    await control`select id from labels where account_id=${fixture.accountId} and provider_label_id='INBOX' for no key update`;
    firstIngestion = upsertMailboxThreadMessages({
      messages: [fixture.message(firstThreadId)], activeRunId: fixture.runId,
    }, firstDatabase);
    await blocked;
    await upsertMailboxThreadMessages({
      messages: [fixture.message(secondThreadId)], activeRunId: fixture.runId,
    }, secondDatabase);
    const [run] = await secondDatabase.select({ count: schema.mailSyncRuns.processedThreadCount })
      .from(schema.mailSyncRuns).where(eq(schema.mailSyncRuns.id, fixture.runId));
    assert.equal(run?.count, 1);
    const items = await secondDatabase.select({ threadId: schema.gmailSyncItems.providerThreadId, status: schema.gmailSyncItems.status })
      .from(schema.gmailSyncItems).where(eq(schema.gmailSyncItems.runId, fixture.runId));
    assert.equal(items.find((item) => item.threadId === firstThreadId)?.status, "running");
    assert.equal(items.find((item) => item.threadId === secondThreadId)?.status, "complete");
  } finally {
    await control`rollback`;
    control.release();
    try {
      if (firstIngestion) await firstIngestion;
    } finally {
      await controlDatabase.delete(schema.profiles).where(eq(schema.profiles.id, fixture.userId));
      await Promise.all([firstClient.end(), secondClient.end(), controlClient.end()]);
    }
  }
});

test("concurrent ingestion creates missing Gmail labels and repairs changed label metadata", {
  skip: !testDatabaseUrl, timeout: 15_000,
}, async () => {
  if (!testDatabaseUrl) return;
  const client = postgres(testDatabaseUrl, { max: 3, prepare: false });
  const database = drizzle(client, { schema });
  const fixture = await createIngestionFixture(database);
  try {
    await database.update(schema.labels).set({ name: "Old inbox", normalizedName: "old inbox" })
      .where(and(eq(schema.labels.accountId, fixture.accountId), eq(schema.labels.providerLabelId, "INBOX")));
    await Promise.all(fixture.providerThreadIds.map((providerThreadId) => upsertMailboxThreadMessages({
      messages: [{
        ...fixture.message(providerThreadId),
        gmailLabels: [{ providerLabelId: "UNREAD", name: "Unread" }, { providerLabelId: "INBOX", name: "Inbox" }],
      }], activeRunId: fixture.runId,
    }, database)));
    const storedLabels = await database.select({
      providerLabelId: schema.labels.providerLabelId, name: schema.labels.name,
      normalizedName: schema.labels.normalizedName,
    }).from(schema.labels).where(eq(schema.labels.accountId, fixture.accountId));
    assert.deepEqual(storedLabels.filter((label) => label.providerLabelId)
      .sort((left, right) => (left.providerLabelId ?? "").localeCompare(right.providerLabelId ?? "")), [
      { providerLabelId: "INBOX", name: "Inbox", normalizedName: "inbox" },
      { providerLabelId: "UNREAD", name: "Unread", normalizedName: "unread" },
    ]);
    const memberships = await database.select({ id: schema.messageLabels.id })
      .from(schema.messageLabels).where(eq(schema.messageLabels.accountId, fixture.accountId));
    assert.equal(memberships.length, 4);
    const [run] = await database.select({ count: schema.mailSyncRuns.processedThreadCount })
      .from(schema.mailSyncRuns).where(eq(schema.mailSyncRuns.id, fixture.runId));
    assert.equal(run?.count, 2);
  } finally {
    await database.delete(schema.profiles).where(eq(schema.profiles.id, fixture.userId));
    await client.end();
  }
});

for (const transition of ["superseded", "disconnected"] as const) {
  test(`ingestion rolls back messages, label admission, and checkpoints when ${transition} mid-transaction`, {
    skip: !testDatabaseUrl, timeout: 15_000,
  }, async () => {
    if (!testDatabaseUrl) return;
    let resolveBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { resolveBlocked = resolve; });
    const ingestionClient = postgres(testDatabaseUrl, {
      max: 1, prepare: false,
      debug: (_connection, query) => {
        if (query.includes("pg_advisory_xact_lock")) resolveBlocked?.();
      },
    });
    const controlClient = postgres(testDatabaseUrl, {
      max: 1, prepare: false, connection: { statement_timeout: 3000 },
    });
    const database = drizzle(ingestionClient, { schema });
    const controlDatabase = drizzle(controlClient, { schema });
    const fixture = await createIngestionFixture(controlDatabase);
    const [providerThreadId] = fixture.providerThreadIds;
    assert.ok(providerThreadId);
    const control = await controlClient.reserve();
    let isControlReserved = true;
    let ingestion: ReturnType<typeof upsertMailboxThreadMessages> | undefined;
    try {
      await control`begin`;
      await control`select pg_advisory_xact_lock(hashtextextended(${`${fixture.accountId}:${providerThreadId}`}, 0))`;
      ingestion = upsertMailboxThreadMessages({
        messages: [fixture.message(providerThreadId)], activeRunId: fixture.runId,
      }, database);
      // Install the rejection observer before releasing the blocked transaction.
      const rejected = assert.rejects(ingestion, InactiveMailSyncRunError);
      void rejected.catch(() => undefined);
      await blocked;
      if (transition === "superseded") {
        await control`update mail_sync_runs set status='superseded' where id=${fixture.runId}`;
      } else {
        await control`update connected_accounts set status='disconnected' where id=${fixture.accountId}`;
      }
      await control`commit`;
      control.release();
      isControlReserved = false;
      await rejected;
      assert.deepEqual(await controlDatabase.select({ id: schema.messages.id }).from(schema.messages)
        .where(eq(schema.messages.accountId, fixture.accountId)), []);
      assert.deepEqual(await controlDatabase.select({ id: schema.threads.id }).from(schema.threads)
        .where(eq(schema.threads.accountId, fixture.accountId)), []);
      assert.deepEqual(await controlDatabase.select({ id: schema.workflowSteps.id }).from(schema.workflowSteps)
        .where(eq(schema.workflowSteps.accountId, fixture.accountId)), []);
      const [item] = await controlDatabase.select({ status: schema.gmailSyncItems.status })
        .from(schema.gmailSyncItems).where(eq(schema.gmailSyncItems.runId, fixture.runId));
      assert.equal(item?.status, "running");
      const [run] = await controlDatabase.select({ count: schema.mailSyncRuns.processedThreadCount })
        .from(schema.mailSyncRuns).where(eq(schema.mailSyncRuns.id, fixture.runId));
      assert.equal(run?.count, 0);
    } finally {
      if (isControlReserved) {
        await control`rollback`;
        control.release();
      }
      if (ingestion) await ingestion.catch(() => undefined);
      await controlDatabase.delete(schema.profiles).where(eq(schema.profiles.id, fixture.userId));
      await Promise.all([ingestionClient.end(), controlClient.end()]);
    }
  });
}
