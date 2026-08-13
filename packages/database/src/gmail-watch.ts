import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";

import {
  getDatabase,
  withGmailAccountControlLock,
  type Database,
} from "./client";
import {
  createDailyGmailWatchRenewalStep,
  createGmailWatchRecoveryStep,
} from "./gmail-watch-schedule";
import {
  connectedAccounts,
  gmailWatchStates,
  workflowSteps,
} from "./schema";
import { enqueueWorkflowStep } from "./workflows";

export {
  createDailyGmailWatchRenewalStep,
  createGmailWatchRecoveryStep,
} from "./gmail-watch-schedule";

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
  const now = input.now ?? new Date();
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
    await withGmailAccountControlLock(account.id, async () => {
      const [activeRenewal] = await database
        .select({ id: workflowSteps.id })
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.accountId, account.id),
            eq(workflowSteps.stepType, "gmail.watch.renew"),
            inArray(workflowSteps.status, ["queued", "running"]),
            lt(workflowSteps.attempts, workflowSteps.maxAttempts),
            sql`${workflowSteps.input}->>'cadence' = 'daily'`,
          ),
        )
        .limit(1);
      if (activeRenewal) return;

      const recoveryForStepId = input.recoveryForStepId ?? (
        await database
          .select({ id: workflowSteps.id })
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.accountId, account.id),
              eq(workflowSteps.stepType, "gmail.watch.renew"),
              or(
                eq(workflowSteps.status, "failed"),
                and(
                  inArray(workflowSteps.status, ["queued", "running"]),
                  gte(workflowSteps.attempts, workflowSteps.maxAttempts),
                ),
              ),
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
          now,
        }),
        database,
      );
      repaired += 1;
    });
  }
  return repaired;
}
