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
  gmailAccountCleanups,
  gmailReplicaStates,
  gmailSyncItems,
  gmailSyncPages,
  mailSyncRuns,
  queueOutbox,
  workflowSteps,
} from "./schema";
import type { QueueName, WorkflowStepJob } from "./types";
import { toPostgresTextProjection } from "./text";
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

async function lockMailSyncRun(
  input: { runId: string; accountId?: string; allowCompleted?: boolean },
  database: Database,
) {
  const allowedStatuses = input.allowCompleted
    ? (["queued", "running", "complete"] as const)
    : (["queued", "running"] as const);
  const conditions = [
    eq(mailSyncRuns.id, input.runId),
    inArray(mailSyncRuns.status, allowedStatuses),
  ];
  if (input.accountId) {
    conditions.push(eq(mailSyncRuns.accountId, input.accountId));
  }
  const [run] = await database
    .select({
      id: mailSyncRuns.id,
      userId: mailSyncRuns.userId,
      accountId: mailSyncRuns.accountId,
      discoveryComplete: mailSyncRuns.discoveryComplete,
    })
    .from(mailSyncRuns)
    .where(and(...conditions))
    .for("update")
    .limit(1);
  return run ?? null;
}

function queueNameForStepType(stepType: string): QueueName {
  switch (stepType) {
    case "gmail.sync.page":
    case "gmail.sync.finalize":
      return "gmail-pages";
    case "gmail.sync.message":
      return "gmail-messages";
    case "gmail.history.catchup":
    case "gmail.watch.renew":
    case "gmail.replica.audit":
    case "gmail.account.cleanup":
    case "gmail.action.execute":
      return "gmail-control";
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
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [inserted] = await enqueueWorkflowStepsWithExecutor([input], executor);
    if (inserted) return inserted.id;

    const [existing] = await transaction
      .select({ id: workflowSteps.id, status: workflowSteps.status })
      .from(workflowSteps)
      .where(eq(workflowSteps.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!existing) throw new Error("The workflow step could not be created.");
    if (existing.status === "queued" || existing.status === "running") {
      await transaction
        .insert(queueOutbox)
        .values({
          workflowStepId: existing.id,
          queueName: queueNameForStepType(input.stepType),
        })
        .onConflictDoNothing({ target: queueOutbox.workflowStepId });
    }
    return existing.id;
  });
}

export async function createInitialMailSyncRun(
  input: {
    userId: string;
    accountId: string;
    startingHistoryCursor: string;
  },
  database: Database = getDatabase(),
): Promise<string> {
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [account] = await transaction
      .select({ id: connectedAccounts.id, userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, input.accountId))
      .for("update")
      .limit(1);
    if (!account || account.userId !== input.userId) {
      throw new Error("The Gmail account is unavailable for synchronization.");
    }

    const [activeRun] = await transaction
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.accountId, input.accountId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    const idempotencyKey = `gmail.initial-sync:${input.accountId}`;
    const [inserted] = activeRun
      ? []
      : await transaction
          .insert(mailSyncRuns)
          .values({
            userId: input.userId,
            accountId: input.accountId,
            startingHistoryCursor: input.startingHistoryCursor,
            idempotencyKey,
          })
          .onConflictDoNothing()
          .returning({ id: mailSyncRuns.id });

    let runId = activeRun?.id ?? inserted?.id;
    let active = Boolean(activeRun ?? inserted);
    if (!runId) {
      const [existing] = await transaction
        .select({ id: mailSyncRuns.id, status: mailSyncRuns.status })
        .from(mailSyncRuns)
        .where(eq(mailSyncRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      runId = existing?.id;
      active = existing?.status === "queued" || existing?.status === "running";
    }
    if (!runId) {
      throw new Error("The Gmail synchronization run could not be created.");
    }

    if (active) {
      await enqueueWorkflowStep(
        {
          runId,
          userId: input.userId,
          accountId: input.accountId,
          stepType: "gmail.sync.page",
          payload: { runId, pageNumber: 1, pageToken: null },
          idempotencyKey: `gmail-page:${runId}:1`,
        },
        executor,
      );
    }
    return runId;
  });
}

export async function enqueueMissingMailSyncRuns(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      initialHistoryId: gmailReplicaStates.initialHistoryId,
      replicaState: gmailReplicaStates.state,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.status, "connected"));

  let created = 0;
  for (const account of accounts) {
    if (account.replicaState === "ready" || account.replicaState === "failed") {
      continue;
    }
    const [existingRun] = await database
      .select({ id: mailSyncRuns.id })
      .from(mailSyncRuns)
      .where(
        and(
          eq(mailSyncRuns.accountId, account.id),
          eq(mailSyncRuns.startingHistoryCursor, account.initialHistoryId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (existingRun) {
      await enqueueWorkflowStep(
        {
          runId: existingRun.id,
          userId: account.userId,
          accountId: account.id,
          stepType: "gmail.sync.page",
          payload: { runId: existingRun.id, pageNumber: 1, pageToken: null },
          idempotencyKey: `gmail-page:${existingRun.id}:1`,
        },
        database,
      );
      continue;
    }
    await createInitialMailSyncRun({
      userId: account.userId,
      accountId: account.id,
      startingHistoryCursor: account.initialHistoryId,
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
    .where(
      and(
        eq(workflowSteps.id, stepId),
        inArray(workflowSteps.status, ["queued", "running"]),
      ),
    )
    .returning({ id: workflowSteps.id });
  if (step) return { shouldExecute: true as const, result: null };

  const [terminal] = await database
    .select({ status: workflowSteps.status, result: workflowSteps.result })
    .from(workflowSteps)
    .where(eq(workflowSteps.id, stepId))
    .limit(1);
  if (!terminal) throw new Error("The workflow step no longer exists.");
  return {
    shouldExecute: false as const,
    result:
      terminal.status === "complete"
        ? terminal.result ?? {}
        : { status: "inactive" },
  };
}

export async function completeWorkflowStep(
  stepId: string,
  result: Record<string, unknown> = {},
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [step] = await transaction
      .select({
        status: workflowSteps.status,
        runId: workflowSteps.runId,
        stepType: workflowSteps.stepType,
        accountId: workflowSteps.accountId,
        input: workflowSteps.input,
      })
      .from(workflowSteps)
      .where(eq(workflowSteps.id, stepId))
      .for("update")
      .limit(1);
    if (!step) throw new Error("The workflow step no longer exists.");
    if (step.status !== "queued" && step.status !== "running") return false;
    if (
      step.runId &&
      !(await lockMailSyncRun(
        {
          runId: step.runId,
          accountId: step.accountId ?? undefined,
          allowCompleted: true,
        },
        transaction as unknown as Database,
      ))
    ) {
      return false;
    }

    await transaction
      .update(workflowSteps)
      .set({
        status: "complete",
        result: { ...result, completedAt: new Date().toISOString() },
        lastError: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowSteps.id, stepId));

    if (step.stepType !== "gmail.account.cleanup" || !step.accountId) return true;
    const cleanupId =
      typeof step.input.cleanupId === "string" ? step.input.cleanupId : null;
    if (!cleanupId) {
      throw new Error("The Gmail account cleanup step is missing its audit ID.");
    }
    await transaction
      .update(gmailAccountCleanups)
      .set({
        status: "complete",
        objectCount:
          typeof result.objectCount === "number" ? result.objectCount : null,
        lastError: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(gmailAccountCleanups.id, cleanupId));
    await transaction
      .delete(connectedAccounts)
      .where(eq(connectedAccounts.id, step.accountId));
    return true;
  });
}

export async function failWorkflowStep(
  input: {
    step: WorkflowStepJob;
    message: string;
    terminal: boolean;
  },
  database: Database = getDatabase(),
) {
  const message = toPostgresTextProjection(input.message);
  return database.transaction(async (transaction) => {
    const [updatedStep] = await transaction
      .update(workflowSteps)
      .set({
        status: input.terminal ? "failed" : "queued",
        attempts: input.step.attempts,
        lastError: message,
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
    if (input.step.stepType === "gmail.account.cleanup") {
      const cleanupId =
        typeof input.step.payload.cleanupId === "string"
          ? input.step.payload.cleanupId
          : null;
      if (cleanupId) {
        await transaction
          .update(gmailAccountCleanups)
          .set({
            status: input.terminal ? "failed" : "queued",
            lastError: message,
            completedAt: input.terminal ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(gmailAccountCleanups.id, cleanupId));
      }
    }
    if (
      input.terminal &&
      input.step.accountId &&
      ["gmail.history.catchup", "gmail.watch.renew", "gmail.replica.audit"].includes(
        input.step.stepType,
      )
    ) {
      await transaction
        .update(gmailReplicaStates)
        .set({
          state: "failed",
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(gmailReplicaStates.accountId, input.step.accountId));
    }
    if (input.terminal && input.step.stepType === "embedding.backfill") {
      await transaction
        .update(embeddingBatchSubmissions)
        .set({
          status: "failed",
          lastError: message,
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
  accountId: string,
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
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
          eq(mailSyncRuns.accountId, accountId),
          inArray(mailSyncRuns.status, ["queued", "running"]),
        ),
      )
      .returning({ accountId: mailSyncRuns.accountId });
    if (!run) return false;
    await transaction
      .update(connectedAccounts)
      .set({
        syncState: { mailSync: "running", indexing: "pending", memory: "pending" },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, run.accountId));
    return true;
  });
}

export async function isActiveMailSyncRun(
  input: { runId: string; accountId: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  const [run] = await database
    .select({ id: mailSyncRuns.id })
    .from(mailSyncRuns)
    .where(
      and(
        eq(mailSyncRuns.id, input.runId),
        eq(mailSyncRuns.accountId, input.accountId),
        inArray(mailSyncRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return Boolean(run);
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
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const run = await lockMailSyncRun(
      { runId: input.runId, accountId: input.accountId },
      executor,
    );
    if (!run || run.userId !== input.userId) return false;
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
    if (!insertedPage) return true;

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
    return true;
  });
}

export async function markMailSyncItemRunning(
  runId: string,
  accountId: string,
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
        inArray(gmailSyncItems.status, ["queued", "running"]),
        sql`exists (
          select 1
          from ${mailSyncRuns}
          where ${mailSyncRuns.id} = ${runId}
            and ${mailSyncRuns.accountId} = ${accountId}
            and ${mailSyncRuns.status} in ('queued', 'running')
        )`,
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
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    if (!(await lockMailSyncRun({ runId }, executor))) return false;
    const [item] = await transaction
      .update(gmailSyncItems)
      .set({ status: "complete", lastError: null, completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(gmailSyncItems.runId, runId),
          eq(gmailSyncItems.providerMessageId, providerMessageId),
          inArray(gmailSyncItems.status, ["queued", "running"]),
        ),
      )
      .returning({ id: gmailSyncItems.id });
    if (!item) return false;
    await enqueueFinalizeIfReady(runId, executor);
    return true;
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
  const message = toPostgresTextProjection(input.message);
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    if (!(await lockMailSyncRun({ runId: input.runId }, executor))) return false;
    const [item] = await transaction
      .update(gmailSyncItems)
      .set({
        status: input.terminal ? "failed" : "queued",
        attempts: input.attempt,
        lastError: message,
        completedAt: input.terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gmailSyncItems.runId, input.runId),
          eq(gmailSyncItems.providerMessageId, input.providerMessageId),
          inArray(gmailSyncItems.status, ["queued", "running"]),
        ),
      )
      .returning({ id: gmailSyncItems.id });
    if (!item) return false;
    if (input.terminal) {
      await failMailSyncRun(
        {
          runId: input.runId,
          message,
          reconnectRequired: input.reconnectRequired,
        },
        executor,
      );
    }
    return true;
  });
}

export async function failMailSyncRun(
  input: { runId: string; message: string; reconnectRequired: boolean },
  database: Database = getDatabase(),
) {
  const message = toPostgresTextProjection(input.message);
  const [run] = await database
    .update(mailSyncRuns)
    .set({
      status: "failed",
      lastError: message,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailSyncRuns.id, input.runId),
        inArray(mailSyncRuns.status, ["queued", "running"]),
      ),
    )
    .returning({ accountId: mailSyncRuns.accountId });
  if (!run) return;
  await database.transaction(async (transaction) => {
    await transaction
      .update(connectedAccounts)
      .set({
        status: input.reconnectRequired ? "reconnect_required" : "connected",
        syncState: { mailSync: "failed", indexing: "pending", memory: "pending" },
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, run.accountId));
    await transaction
      .update(gmailReplicaStates)
      .set({ state: "failed", lastError: message, updatedAt: new Date() })
      .where(eq(gmailReplicaStates.accountId, run.accountId));
  });
}

export async function completeMailSyncRun(
  input: { runId: string; finalHistoryCursor: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const [run] = await transaction
      .select({
        userId: mailSyncRuns.userId,
        accountId: mailSyncRuns.accountId,
        discoveryComplete: mailSyncRuns.discoveryComplete,
        status: mailSyncRuns.status,
        replicaState: gmailReplicaStates.state,
        replicaCursor: gmailReplicaStates.historyCursor,
        replicaLastAuditAt: gmailReplicaStates.lastAuditAt,
      })
      .from(mailSyncRuns)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, mailSyncRuns.accountId),
      )
      .where(eq(mailSyncRuns.id, input.runId))
      .for("update")
      .limit(1);
    if (
      !run ||
      (run.status !== "queued" && run.status !== "running")
    ) {
      return false;
    }
    if (
      run.replicaState !== "ready" ||
      run.replicaCursor !== input.finalHistoryCursor ||
      !run.replicaLastAuditAt
    ) {
      throw new Error(
        "The Gmail synchronization run cannot complete before audited replica readiness.",
      );
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
    return true;
  });
}

export async function enqueuePostSyncWorkflowSteps(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      historyCursor: gmailReplicaStates.historyCursor,
      replicaState: gmailReplicaStates.state,
      replicaLastAuditAt: gmailReplicaStates.lastAuditAt,
      syncState: connectedAccounts.syncState,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(eq(connectedAccounts.status, "connected"));
  let inserted = 0;
  for (const account of accounts) {
    if (
      account.syncState.mailSync !== "complete" ||
      account.replicaState !== "ready" ||
      !account.replicaLastAuditAt ||
      !account.historyCursor
    ) continue;
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
