import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import {
  connectedAccounts,
  gmailWatchStates,
  workflowSteps,
} from "./schema";
import { enqueueWorkflowStep, type WorkflowStepInput } from "./workflows";

const DAILY_WATCH_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function createDailyGmailWatchRenewalStep(input: {
  userId: string;
  accountId: string;
  renewedAt: Date;
  expectedExpirationAt: Date;
}): WorkflowStepInput {
  const runAt = new Date(
    input.renewedAt.getTime() + DAILY_WATCH_RENEWAL_INTERVAL_MS,
  );
  const renewalDay = runAt.toISOString().slice(0, 10);
  return {
    userId: input.userId,
    accountId: input.accountId,
    stepType: "gmail.watch.renew",
    payload: {
      cadence: "daily",
      runAt: runAt.toISOString(),
      expectedExpirationAt: input.expectedExpirationAt.toISOString(),
    },
    idempotencyKey: `gmail-watch-renew:${input.accountId}:daily:${renewalDay}`,
  };
}

export function createGmailWatchRecoveryStep(input: {
  userId: string;
  accountId: string;
  expectedExpirationAt: Date;
  recoveryKey: string;
  now: Date;
}): WorkflowStepInput {
  const dailyRunAt = input.now.getTime() + DAILY_WATCH_RENEWAL_INTERVAL_MS;
  const expirationSafetyRunAt =
    input.expectedExpirationAt.getTime() - DAILY_WATCH_RENEWAL_INTERVAL_MS;
  const runAt = new Date(
    Math.max(input.now.getTime(), Math.min(dailyRunAt, expirationSafetyRunAt)),
  );
  return {
    userId: input.userId,
    accountId: input.accountId,
    stepType: "gmail.watch.renew",
    payload: {
      cadence: "daily",
      reason: "terminal_failure_recovery",
      recoveryKey: input.recoveryKey,
      runAt: runAt.toISOString(),
      expectedExpirationAt: input.expectedExpirationAt.toISOString(),
    },
    idempotencyKey: `gmail-watch-renew:${input.accountId}:recovery:${input.recoveryKey}`,
  };
}

export function enqueueDailyGmailWatchRenewal(
  input: {
    userId: string;
    accountId: string;
    renewedAt: Date;
    expectedExpirationAt: Date;
  },
  database: Database = getDatabase(),
): Promise<string> {
  return enqueueWorkflowStep(createDailyGmailWatchRenewalStep(input), database);
}

export async function ensureDailyGmailWatchRenewals(
  input: {
    accountId?: string;
    recoveryForStepId?: string;
    now?: Date;
  } = {},
  database: Database = getDatabase(),
): Promise<number> {
  const accountConditions = [
    eq(connectedAccounts.status, "connected"),
    eq(gmailWatchStates.status, "active"),
  ];
  if (input.accountId) {
    accountConditions.push(eq(connectedAccounts.id, input.accountId));
  }
  const accounts = await database
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      expirationAt: gmailWatchStates.expirationAt,
      lastRenewedAt: gmailWatchStates.lastRenewedAt,
    })
    .from(connectedAccounts)
    .innerJoin(
      gmailWatchStates,
      eq(gmailWatchStates.accountId, connectedAccounts.id),
    )
    .where(and(...accountConditions));

  let repaired = 0;
  for (const account of accounts) {
    const [activeRenewal] = await database
      .select({ id: workflowSteps.id })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.accountId, account.id),
          eq(workflowSteps.stepType, "gmail.watch.renew"),
          inArray(workflowSteps.status, ["queued", "running"]),
          sql`${workflowSteps.input}->>'cadence' = 'daily'`,
        ),
      )
      .limit(1);
    if (activeRenewal) continue;

    const recoveryForStepId = input.recoveryForStepId ?? (
      await database
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, account.id),
            eq(workflowSteps.stepType, "gmail.watch.renew"),
            eq(workflowSteps.status, "failed"),
          ),
        )
        .orderBy(desc(workflowSteps.completedAt), desc(workflowSteps.updatedAt))
        .limit(1)
    )[0]?.id;
    const recoveryKey = recoveryForStepId
      ? `failed:${recoveryForStepId}`
      : `state:${account.lastRenewedAt.getTime()}:${account.expirationAt.getTime()}`;
    await enqueueWorkflowStep(
      createGmailWatchRecoveryStep({
        userId: account.userId,
        accountId: account.id,
        expectedExpirationAt: account.expirationAt,
        recoveryKey,
        now: input.now ?? new Date(),
      }),
      database,
    );
    repaired += 1;
  }
  return repaired;
}
