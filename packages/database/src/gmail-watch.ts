import { getDatabase, type Database } from "./client";
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
