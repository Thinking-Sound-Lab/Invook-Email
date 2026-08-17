import type { WorkflowStepInput } from "./types";

export const GMAIL_WATCH_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function createDailyGmailWatchRenewalStep(input: {
  userId: string;
  accountId: string;
  renewedAt: Date;
  expectedExpirationAt: Date;
}): WorkflowStepInput {
  const runAt = new Date(
    input.renewedAt.getTime() + GMAIL_WATCH_RENEWAL_INTERVAL_MS,
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
  const dailyRunAt = input.now.getTime() + GMAIL_WATCH_RENEWAL_INTERVAL_MS;
  const expirationSafetyRunAt =
    input.expectedExpirationAt.getTime() - GMAIL_WATCH_RENEWAL_INTERVAL_MS;
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

export function createImmediateGmailRepairRecoveryStep(input: {
  userId: string;
  accountId: string;
  failedRunId: string;
  now: Date;
}): WorkflowStepInput {
  return {
    userId: input.userId,
    accountId: input.accountId,
    stepType: "gmail.watch.renew",
    payload: {
      cadence: "recovery",
      reason: "terminal_sync_failure_recovery",
      failedRunId: input.failedRunId,
      runAt: input.now.toISOString(),
    },
    idempotencyKey: `gmail-repair-recovery:${input.accountId}:${input.failedRunId}`,
  };
}
