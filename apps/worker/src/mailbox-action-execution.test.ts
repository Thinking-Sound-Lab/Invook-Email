import assert from "node:assert/strict";
import test from "node:test";

import {
  MailboxActionTargetError,
  runMailboxActionExecution,
  type MailboxActionExecutionDependencies,
} from "./mailbox-action-execution";

type Target = {
  id: string;
  status: "pending" | "executing" | "completed" | "failed" | "stale";
};

function dependencies(
  overrides: Partial<MailboxActionExecutionDependencies<Target>> = {},
): MailboxActionExecutionDependencies<Target> {
  return {
    load: async () => ({
      id: "proposal",
      operation: "archive",
      isLabelCurrent: true,
      targets: [{ id: "message-1", status: "pending" }],
    }),
    claim: async (target) => ({ state: "ready", target }),
    execute: async (target) => ({ targetId: target.id }),
    complete: async () => undefined,
    fail: async () => undefined,
    markRemainingStale: async () => undefined,
    enqueueHistoryCatchup: async () => "history-step",
    finalize: async () => ({
      status: "completed",
      completedCount: 1,
      failedCount: 0,
    }),
    ...overrides,
  };
}

test("no Gmail mutation or history catch-up occurs before approval", async () => {
  let providerWriteCount = 0;
  let catchupCount = 0;
  const result = await runMailboxActionExecution(
    dependencies({
      load: async () => null,
      execute: async () => {
        providerWriteCount += 1;
        return {};
      },
      enqueueHistoryCatchup: async () => {
        catchupCount += 1;
        return "history-step";
      },
    }),
  );

  assert.deepEqual(result, { status: "inactive" });
  assert.equal(providerWriteCount, 0);
  assert.equal(catchupCount, 0);
});

test("execution uses only the proposal's frozen exact target set", async () => {
  const executedTargetIds: string[] = [];
  await runMailboxActionExecution(
    dependencies({
      load: async () => ({
        id: "proposal",
        operation: "mark_read",
        isLabelCurrent: true,
        targets: [
          { id: "frozen-1", status: "pending" },
          { id: "frozen-2", status: "pending" },
        ],
      }),
      execute: async (target) => {
        executedTargetIds.push(target.id);
        return {};
      },
      finalize: async () => ({
        status: "completed",
        completedCount: 2,
        failedCount: 0,
      }),
    }),
  );

  assert.deepEqual(executedTargetIds, ["frozen-1", "frozen-2"]);
});

test("partial provider failure is recorded per target and still queues catch-up", async () => {
  const completed: string[] = [];
  const failed: Array<{ id: string; code: string }> = [];
  let catchupCount = 0;
  const result = await runMailboxActionExecution(
    dependencies({
      load: async () => ({
        id: "proposal",
        operation: "trash",
        isLabelCurrent: true,
        targets: [
          { id: "success", status: "pending" },
          { id: "failure", status: "pending" },
        ],
      }),
      execute: async (target) => {
        if (target.id === "failure") {
          throw new MailboxActionTargetError(
            "provider_target_missing",
            "Provider target is gone",
          );
        }
        return { providerMessageId: "provider-success" };
      },
      complete: async (targetId) => {
        completed.push(targetId);
      },
      fail: async (targetId, errorCode) => {
        failed.push({ id: targetId, code: errorCode });
      },
      enqueueHistoryCatchup: async () => {
        catchupCount += 1;
        return "history-step";
      },
      finalize: async () => ({
        status: "partial_failure",
        completedCount: 1,
        failedCount: 1,
      }),
    }),
  );

  assert.deepEqual(completed, ["success"]);
  assert.deepEqual(failed, [
    { id: "failure", code: "provider_target_missing" },
  ]);
  assert.equal(catchupCount, 1);
  assert.equal(result.status, "partial_failure");
});

test("stale or deleted local targets never reach the provider", async () => {
  let providerWriteCount = 0;
  await runMailboxActionExecution(
    dependencies({
      claim: async (target) => ({ state: "stale", target }),
      execute: async () => {
        providerWriteCount += 1;
        return {};
      },
      finalize: async () => ({
        status: "failed",
        completedCount: 0,
        failedCount: 1,
      }),
    }),
  );

  assert.equal(providerWriteCount, 0);
});

test("a retry skips completed targets while preserving idempotent history catch-up", async () => {
  let providerWriteCount = 0;
  let catchupCount = 0;
  await runMailboxActionExecution(
    dependencies({
      load: async () => ({
        id: "proposal",
        operation: "archive",
        isLabelCurrent: true,
        targets: [{ id: "already-complete", status: "completed" }],
      }),
      claim: async (target) => ({ state: "skip", target }),
      execute: async () => {
        providerWriteCount += 1;
        return {};
      },
      enqueueHistoryCatchup: async () => {
        catchupCount += 1;
        return "same-idempotent-history-step";
      },
    }),
  );

  assert.equal(providerWriteCount, 0);
  assert.equal(catchupCount, 1);
});
