import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import {
  connectedAccounts,
  embeddingBatchSubmissions,
  gmailSyncItems,
  gmailSyncPages,
  mailSyncRuns,
  queueOutbox,
  workflowSteps,
} from "./schema";
import type { QueueName, WorkflowStepJob } from "./types";
import {
  MAIL_INDEX_VERSION,
  MEMORY_SCHEMA_VERSION,
} from "./versions";

export type WorkflowStepInput = {
  runId?: string | null;
  userId?: string | null;
  accountId?: string | null;
  stepType: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  idempotencyKey: string;
};

export type OutboxJob = WorkflowStepJob & {
  queueName: QueueName;
};

function queueNameForStepType(stepType: string): QueueName {
  switch (stepType) {
    case "gmail.sync.page":
    case "gmail.sync.finalize":
      return "gmail-pages";
    case "gmail.sync.message":
      return "gmail-messages";
    case "embedding.backfill":
    case "embedding.batch.event":
      return "mail-indexing-batch";
    case "embedding.incremental":
      return "mail-indexing-live";
    case "memory.extract":
      return "mail-memory-submit";
    case "memory.batch.retry":
    case "memory.batch.event":
      return "mail-memory-events";
    case "memory.feedback":
      return "mail-memory-feedback";
    default:
      throw new Error(`Unsupported workflow step type: ${stepType}`);
  }
}

async function enqueueWorkflowStepsWithExecutor(
  inputs: WorkflowStepInput[],
  database: Database,
): Promise<Array<{ id: string; idempotencyKey: string }>> {
  if (inputs.length === 0) return [];
  const inserted = await database
    .insert(workflowSteps)
    .values(
      inputs.map((input) => ({
        runId: input.runId ?? null,
        userId: input.userId ?? null,
        accountId: input.accountId ?? null,
        stepType: input.stepType,
        status: "queued" as const,
        input: input.payload ?? {},
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        idempotencyKey: input.idempotencyKey,
      })),
    )
    .onConflictDoNothing({ target: workflowSteps.idempotencyKey })
    .returning({ id: workflowSteps.id, idempotencyKey: workflowSteps.idempotencyKey });

  if (inserted.length > 0) {
    const byIdempotencyKey = new Map(
      inputs.map((input) => [input.idempotencyKey, input] as const),
    );
    await database.insert(queueOutbox).values(
      inserted.map((step) => ({
        workflowStepId: step.id,
        queueName: queueNameForStepType(
          byIdempotencyKey.get(step.idempotencyKey)!.stepType,
        ),
      })),
    );
  }
  return inserted;
}

export async function enqueueWorkflowStep(
  input: WorkflowStepInput,
  database: Database = getDatabase(),
): Promise<string> {
  const [inserted] = await enqueueWorkflowStepsWithExecutor([input], database);
  if (inserted) return inserted.id;

  const [existing] = await database
    .select({ id: workflowSteps.id })
    .from(workflowSteps)
    .where(eq(workflowSteps.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error("The workflow step could not be created.");
  return existing.id;
}

export async function createInitialMailSyncRun(
  input: {
    userId: string;
    accountId: string;
    startingHistoryCursor: string;
    connectionEventId?: string;
  },
  database: Database = getDatabase(),
): Promise<string> {
  const idempotencyKey = [
    "gmail.initial-sync",
    input.accountId,
    input.startingHistoryCursor,
    input.connectionEventId,
  ]
    .filter(Boolean)
    .join(":");
  const [inserted] = await database
    .insert(mailSyncRuns)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      startingHistoryCursor: input.startingHistoryCursor,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: mailSyncRuns.idempotencyKey })
    .returning({ id: mailSyncRuns.id });

  let runId = inserted?.id;
  if (!runId) {
    const [existing] = await database
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(eq(mailSyncRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    runId = existing?.id;
  }
  if (!runId) throw new Error("The Gmail synchronization run could not be created.");

  if (inserted) {
    await enqueueWorkflowStep(
      {
        runId,
        userId: input.userId,
        accountId: input.accountId,
        stepType: "gmail.sync.page",
        payload: { runId, pageNumber: 1, pageToken: null },
        idempotencyKey: `gmail-page:${runId}:1`,
      },
      database,
    );
  }
  return runId;
}

export async function enqueueMissingMailSyncRuns(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      historyCursor: connectedAccounts.historyCursor,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, "connected"));

  let created = 0;
  for (const account of accounts) {
    if (account.syncState.mailSync === "complete" || !account.historyCursor) continue;
    const [existingRun] = await database
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.accountId, account.id),
          eq(mailSyncRuns.startingHistoryCursor, account.historyCursor),
        ),
      )
      .limit(1);
    if (existingRun) continue;
    await createInitialMailSyncRun({
      userId: account.userId,
      accountId: account.id,
      startingHistoryCursor: account.historyCursor,
    }, database);
    created += 1;
  }
  return created;
}

export async function publishOutboxBatch(
  publish: (jobs: OutboxJob[]) => Promise<void>,
  database: Database = getDatabase(),
): Promise<{ published: number; failed: boolean }> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        outboxId: queueOutbox.id,
        queueName: queueOutbox.queueName,
        id: workflowSteps.id,
        runId: workflowSteps.runId,
        userId: workflowSteps.userId,
        accountId: workflowSteps.accountId,
        stepType: workflowSteps.stepType,
        payload: workflowSteps.input,
        attempts: workflowSteps.attempts,
        maxAttempts: workflowSteps.maxAttempts,
      })
      .from(queueOutbox)
      .innerJoin(workflowSteps, eq(workflowSteps.id, queueOutbox.workflowStepId))
      .where(isNull(queueOutbox.publishedAt))
      .orderBy(asc(queueOutbox.createdAt))
      .limit(100)
      .for("update", { skipLocked: true });

    if (rows.length === 0) return { published: 0, failed: false };
    const jobs = rows.map(({ outboxId: _outboxId, ...job }) => job);
    try {
      await publish(jobs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Queue publication failed";
      await transaction
        .update(queueOutbox)
        .set({
          publishAttempts: sql`${queueOutbox.publishAttempts} + 1`,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(inArray(queueOutbox.id, rows.map((row) => row.outboxId)));
      return { published: 0, failed: true };
    }

    await transaction
      .update(queueOutbox)
      .set({
        publishAttempts: sql`${queueOutbox.publishAttempts} + 1`,
        lastError: null,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(queueOutbox.id, rows.map((row) => row.outboxId)));
    return { published: rows.length, failed: false };
  });
}

export async function markWorkflowStepRunning(
  stepId: string,
  attempt: number,
  database: Database = getDatabase(),
) {
  const [step] = await database
    .update(workflowSteps)
    .set({
      status: "running",
      attempts: attempt,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(workflowSteps.id, stepId), ne(workflowSteps.status, "complete")))
    .returning({ id: workflowSteps.id });
  if (step) return { alreadyComplete: false as const, result: null };

  const [completed] = await database
    .select({ status: workflowSteps.status, result: workflowSteps.result })
    .from(workflowSteps)
    .where(eq(workflowSteps.id, stepId))
    .limit(1);
  if (!completed) throw new Error("The workflow step no longer exists.");
  if (completed.status !== "complete") {
    throw new Error("The workflow step could not be started.");
  }
  return {
    alreadyComplete: true as const,
    result: completed.result ?? {},
  };
}

export async function completeWorkflowStep(
  stepId: string,
  result: Record<string, unknown> = {},
  database: Database = getDatabase(),
) {
  await database
    .update(workflowSteps)
    .set({
      status: "complete",
      result: { ...result, completedAt: new Date().toISOString() },
      lastError: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workflowSteps.id, stepId));
}

export async function failWorkflowStep(
  input: {
    step: WorkflowStepJob;
    message: string;
    terminal: boolean;
  },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [updatedStep] = await transaction
      .update(workflowSteps)
      .set({
        status: input.terminal ? "failed" : "queued",
        attempts: input.step.attempts,
        lastError: input.message,
        completedAt: input.terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowSteps.id, input.step.id),
          ne(workflowSteps.status, "complete"),
        ),
      )
      .returning({ id: workflowSteps.id });

    if (!updatedStep) return false;
    if (input.terminal && input.step.stepType === "embedding.backfill") {
      await transaction
        .update(embeddingBatchSubmissions)
        .set({
          status: "failed",
          lastError: input.message,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(embeddingBatchSubmissions.workflowStepId, input.step.id),
            eq(embeddingBatchSubmissions.status, "preparing"),
          ),
        );
    }
    if (!input.terminal || !input.step.accountId) return true;
    if (
      ["memory.extract", "memory.batch.retry", "memory.batch.event"].includes(
        input.step.stepType,
      )
    ) {
      await transaction
        .update(connectedAccounts)
        .set({
          syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{memory}', to_jsonb(${"failed"}::text), true)`,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, input.step.accountId));
    }
    if (
      ["embedding.backfill", "embedding.incremental", "embedding.batch.event"].includes(
        input.step.stepType,
      )
    ) {
      await transaction
        .update(connectedAccounts)
        .set({
          syncState: sql`jsonb_set(${connectedAccounts.syncState}, '{indexing}', to_jsonb(${"failed"}::text), true)`,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, input.step.accountId));
      await transaction.execute(
        sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: input.step.accountId, state: "failed" })})`,
      );
    }
    return true;
  });
}

export async function startMailSyncRun(
  runId: string,
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const [run] = await transaction
      .update(mailSyncRuns)
      .set({
        status: "running",
        startedAt: sql`coalesce(${mailSyncRuns.startedAt}, now())`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailSyncRuns.id, runId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .returning({ accountId: mailSyncRuns.accountId });
    if (!run) return;
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: { mailSync: "running", indexing: "pending", memory: "pending" },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, run.accountId));
  });
}

export async function hasCompletedMailSyncPage(
  runId: string,
  pageNumber: number,
  database: Database = getDatabase(),
): Promise<boolean> {
  const [page] = await database
    .select({ id: gmailSyncPages.id })
    .from(gmailSyncPages)
    .where(and(eq(gmailSyncPages.runId, runId), eq(gmailSyncPages.pageNumber, pageNumber)))
    .limit(1);
  return Boolean(page);
}

export async function recordMailSyncPage(
  input: {
    runId: string;
    userId: string;
    accountId: string;
    pageNumber: number;
    pageToken: string | null;
    nextPageToken: string | null;
    providerMessageIds: string[];
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [insertedPage] = await transaction
      .insert(gmailSyncPages)
      .values({
        runId: input.runId,
        pageNumber: input.pageNumber,
        pageToken: input.pageToken,
        nextPageToken: input.nextPageToken,
        discoveredMessageCount: input.providerMessageIds.length,
      })
      .onConflictDoNothing({ target: [gmailSyncPages.runId, gmailSyncPages.pageNumber] })
      .returning({ id: gmailSyncPages.id });
    if (!insertedPage) return;

    const uniqueMessageIds = Array.from(new Set(input.providerMessageIds));
    const insertedItems = uniqueMessageIds.length
      ? await transaction
          .insert(gmailSyncItems)
          .values(
            uniqueMessageIds.map((providerMessageId) => ({
              runId: input.runId,
              providerMessageId,
            })),
          )
          .onConflictDoNothing({
            target: [gmailSyncItems.runId, gmailSyncItems.providerMessageId],
          })
          .returning({ providerMessageId: gmailSyncItems.providerMessageId })
      : [];

    await enqueueWorkflowStepsWithExecutor(
      insertedItems.map((item) => ({
        runId: input.runId,
        userId: input.userId,
        accountId: input.accountId,
        stepType: "gmail.sync.message",
        payload: {
          runId: input.runId,
          providerMessageId: item.providerMessageId,
        },
        idempotencyKey: `gmail-message:${input.runId}:${item.providerMessageId}`,
      })),
      executor,
    );

    if (input.nextPageToken) {
      await enqueueWorkflowStep(
        {
          runId: input.runId,
          userId: input.userId,
          accountId: input.accountId,
          stepType: "gmail.sync.page",
          payload: {
            runId: input.runId,
            pageNumber: input.pageNumber + 1,
            pageToken: input.nextPageToken,
          },
          idempotencyKey: `gmail-page:${input.runId}:${input.pageNumber + 1}`,
        },
        executor,
      );
    }

    const [pageStats] = await transaction
      .select({
        pageCount: count(gmailSyncPages.id),
        discoveredMessageCount: sql<number>`coalesce(sum(${gmailSyncPages.discoveredMessageCount}), 0)`.mapWith(Number),
      })
      .from(gmailSyncPages)
      .where(eq(gmailSyncPages.runId, input.runId));
    await transaction
      .update(mailSyncRuns)
      .set({
        pageCount: pageStats?.pageCount ?? 0,
        discoveredMessageCount: pageStats?.discoveredMessageCount ?? 0,
        discoveryComplete: input.nextPageToken === null ? true : undefined,
        updatedAt: new Date(),
      })
      .where(eq(mailSyncRuns.id, input.runId));

    if (input.nextPageToken === null && insertedItems.length === 0) {
      await enqueueFinalizeIfReady(input.runId, executor);
    }
  });
}

export async function markMailSyncItemRunning(
  runId: string,
  providerMessageId: string,
  attempt: number,
  database: Database = getDatabase(),
) {
  const [item] = await database
    .update(gmailSyncItems)
    .set({
      status: "running",
      attempts: attempt,
      lastError: null,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gmailSyncItems.runId, runId),
        eq(gmailSyncItems.providerMessageId, providerMessageId),
        ne(gmailSyncItems.status, "complete"),
      ),
    )
    .returning({ id: gmailSyncItems.id });
  return Boolean(item);
}

async function getItemCounts(runId: string, database: Database) {
  const [counts] = await database
    .select({
      total: count(gmailSyncItems.id),
      complete: sql<number>`count(*) filter (where ${gmailSyncItems.status} = 'complete')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${gmailSyncItems.status} = 'failed')`.mapWith(Number),
    })
    .from(gmailSyncItems)
    .where(eq(gmailSyncItems.runId, runId));
  return {
    total: counts?.total ?? 0,
    complete: counts?.complete ?? 0,
    failed: counts?.failed ?? 0,
  };
}

async function enqueueFinalizeIfReady(runId: string, database: Database) {
  const [run] = await database
    .select({
      id: mailSyncRuns.id,
      userId: mailSyncRuns.userId,
      accountId: mailSyncRuns.accountId,
      status: mailSyncRuns.status,
      discoveryComplete: mailSyncRuns.discoveryComplete,
    })
    .from(mailSyncRuns)
    .where(eq(mailSyncRuns.id, runId))
    .limit(1)
    .for("update");
  if (
    !run ||
    (run.status !== "queued" && run.status !== "running") ||
    !run.discoveryComplete
  ) {
    return false;
  }

  const counts = await getItemCounts(runId, database);
  await database
    .update(mailSyncRuns)
    .set({
      discoveredMessageCount: counts.total,
      processedMessageCount: counts.complete,
      failedMessageCount: counts.failed,
      updatedAt: new Date(),
    })
    .where(eq(mailSyncRuns.id, runId));
  if (counts.failed > 0 || counts.complete !== counts.total) return false;

  await enqueueWorkflowStep(
    {
      runId,
      userId: run.userId,
      accountId: run.accountId,
      stepType: "gmail.sync.finalize",
      payload: { runId },
      idempotencyKey: `gmail-finalize:${runId}`,
    },
    database,
  );
  return true;
}

export async function enqueueReadyMailSyncFinalizers(
  database: Database = getDatabase(),
): Promise<number> {
  const runs = await database
    .select({ id: mailSyncRuns.id })
    .from(mailSyncRuns)
    .where(
      and(
        inArray(mailSyncRuns.status, ["queued", "running"]),
        eq(mailSyncRuns.discoveryComplete, true),
      ),
    );

  let readyRunCount = 0;
  for (const run of runs) {
    const ready = await database.transaction((transaction) =>
      enqueueFinalizeIfReady(run.id, transaction as unknown as Database),
    );
    if (ready) readyRunCount += 1;
  }
  return readyRunCount;
}

export async function completeMailSyncItem(
  runId: string,
  providerMessageId: string,
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    await transaction
      .update(gmailSyncItems)
      .set({ status: "complete", lastError: null, completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(gmailSyncItems.runId, runId),
          eq(gmailSyncItems.providerMessageId, providerMessageId),
          ne(gmailSyncItems.status, "complete"),
        ),
      );
    await enqueueFinalizeIfReady(runId, executor);
  });
}

export async function failMailSyncItem(
  input: {
    runId: string;
    providerMessageId: string;
    attempt: number;
    message: string;
    terminal: boolean;
    reconnectRequired: boolean;
  },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    await transaction
      .update(gmailSyncItems)
      .set({
        status: input.terminal ? "failed" : "queued",
        attempts: input.attempt,
        lastError: input.message,
        completedAt: input.terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gmailSyncItems.runId, input.runId),
          eq(gmailSyncItems.providerMessageId, input.providerMessageId),
          ne(gmailSyncItems.status, "complete"),
        ),
      );
    if (input.terminal) {
      await failMailSyncRun(
        {
          runId: input.runId,
          message: input.message,
          reconnectRequired: input.reconnectRequired,
        },
        transaction as unknown as Database,
      );
    }
  });
}

export async function failMailSyncRun(
  input: { runId: string; message: string; reconnectRequired: boolean },
  database: Database = getDatabase(),
) {
  const [run] = await database
    .update(mailSyncRuns)
    .set({
      status: "failed",
      lastError: input.message,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailSyncRuns.id, input.runId))
    .returning({ accountId: mailSyncRuns.accountId });
  if (!run) return;
  await database
    .update(connectedAccounts)
    .set({
      status: input.reconnectRequired ? "reconnect_required" : "connected",
      syncState: { mailSync: "failed", indexing: "pending", memory: "pending" },
      updatedAt: new Date(),
    })
    .where(eq(connectedAccounts.id, run.accountId));
}

export async function completeMailSyncRun(
  input: { runId: string; finalHistoryCursor: string },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [run] = await transaction
      .select({
        userId: mailSyncRuns.userId,
        accountId: mailSyncRuns.accountId,
        discoveryComplete: mailSyncRuns.discoveryComplete,
        status: mailSyncRuns.status,
      })
      .from(mailSyncRuns)
      .where(eq(mailSyncRuns.id, input.runId))
      .limit(1);
    if (!run || run.status === "failed") {
      throw new Error("The Gmail synchronization run is unavailable for finalization.");
    }
    const counts = await getItemCounts(input.runId, executor);
    if (!run.discoveryComplete || counts.failed > 0 || counts.complete !== counts.total) {
      throw new Error("The Gmail synchronization run still has unfinished messages.");
    }

    await transaction
      .update(mailSyncRuns)
      .set({
        status: "complete",
        finalHistoryCursor: input.finalHistoryCursor,
        discoveredMessageCount: counts.total,
        processedMessageCount: counts.complete,
        failedMessageCount: counts.failed,
        completedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mailSyncRuns.id, input.runId));
    await transaction
      .update(connectedAccounts)
      .set({
        historyCursor: input.finalHistoryCursor,
        lastSyncedAt: new Date(),
        syncState: { mailSync: "complete", indexing: "pending", memory: "pending" },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, run.accountId));
    await transaction.execute(
      sql`select pg_notify('invook_account_sync', ${JSON.stringify({ accountId: run.accountId, state: "pending" })})`,
    );

    await enqueueWorkflowStepsWithExecutor(
      [
        {
          userId: run.userId,
          accountId: run.accountId,
          stepType: "embedding.backfill",
          payload: { indexVersion: MAIL_INDEX_VERSION },
          idempotencyKey: `embedding.backfill:${run.accountId}:${MAIL_INDEX_VERSION}:${input.finalHistoryCursor}`,
        },
        {
          userId: run.userId,
          accountId: run.accountId,
          stepType: "memory.extract",
          payload: { schemaVersion: MEMORY_SCHEMA_VERSION },
          idempotencyKey: `memory.extract:${run.accountId}:${MEMORY_SCHEMA_VERSION}:${input.finalHistoryCursor}`,
        },
      ],
      executor,
    );
  });
}

export async function enqueuePostSyncWorkflowSteps(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      historyCursor: connectedAccounts.historyCursor,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, "connected"));
  let inserted = 0;
  for (const account of accounts) {
    if (account.syncState.mailSync !== "complete" || !account.historyCursor) continue;
    const steps = await enqueueWorkflowStepsWithExecutor(
      [
        {
          userId: account.userId,
          accountId: account.id,
          stepType: "memory.extract",
          payload: { schemaVersion: MEMORY_SCHEMA_VERSION },
          idempotencyKey: `memory.extract:${account.id}:${MEMORY_SCHEMA_VERSION}:${account.historyCursor}`,
        },
        {
          userId: account.userId,
          accountId: account.id,
          stepType: "embedding.backfill",
          payload: { indexVersion: MAIL_INDEX_VERSION },
          idempotencyKey: `embedding.backfill:${account.id}:${MAIL_INDEX_VERSION}:${account.historyCursor}`,
        },
      ],
      database,
    );
    inserted += steps.length;
  }
  return inserted;
}

export async function getWorkflowStepSubmission(
  stepId: string,
  database: Database = getDatabase(),
) {
  const [step] = await database
    .select({
      id: workflowSteps.id,
      userId: workflowSteps.userId,
      accountId: workflowSteps.accountId,
      jobType: workflowSteps.stepType,
      result: workflowSteps.result,
      maxAttempts: workflowSteps.maxAttempts,
    })
    .from(workflowSteps)
    .where(
      and(
        eq(workflowSteps.id, stepId),
        eq(workflowSteps.status, "complete"),
        inArray(workflowSteps.stepType, [
          "memory.extract",
          "memory.batch.retry",
          "embedding.backfill",
        ]),
      ),
    )
    .limit(1);
  return step ?? null;
}

export async function getLatestMemoryBatchSubmission(
  accountId: string,
  database: Database = getDatabase(),
) {
  const [step] = await database
    .select({ result: workflowSteps.result })
    .from(workflowSteps)
    .where(
      and(
        eq(workflowSteps.accountId, accountId),
        eq(workflowSteps.status, "complete"),
        inArray(workflowSteps.stepType, ["memory.extract", "memory.batch.retry"]),
        sql`${workflowSteps.result}->>'status' = 'submitted'`,
      ),
    )
    .orderBy(desc(workflowSteps.updatedAt))
    .limit(1);
  return step?.result ?? null;
}
