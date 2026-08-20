import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowStepJob } from "@invook/database";

import {
  parseHistoricalThreadLabelScanJob,
  parseThreadLabelAnalysisJob,
} from "./thread-label-analysis";

function workflowJob(
  stepType: string,
  payload: Record<string, unknown>,
): WorkflowStepJob {
  return {
    id: "step-1",
    userId: "user-1",
    accountId: "account-1",
    runId: null,
    stepType,
    payload,
    attempts: 1,
    maxAttempts: 5,
  };
}

test("live thread assignment jobs preserve their durable checkpoint", () => {
  assert.deepEqual(
    parseThreadLabelAnalysisJob(
      workflowJob("label.thread.assign", {
        threadId: "thread-1",
        analysisVersion: 2,
        definitionHash: "a".repeat(64),
        lane: "live",
      }),
    ),
    {
      userId: "user-1",
      accountId: "account-1",
      checkpoint: {
        threadId: "thread-1",
        analysisVersion: 2,
        definitionHash: "a".repeat(64),
      },
    },
  );
});

test("live thread assignment jobs reject invalid checkpoints", () => {
  assert.throws(
    () =>
      parseThreadLabelAnalysisJob(
        workflowJob("label.thread.assign", {
          threadId: "thread-1",
          analysisVersion: 0,
          definitionHash: "not-a-sha256",
        }),
      ),
    /positive integer/,
  );
});

test("historical scans accept assigned and unassigned thread checkpoints", () => {
  const parsed = parseHistoricalThreadLabelScanJob(
    workflowJob("label.thread.scan", {
      threadId: "thread-1",
      labelId: "billing-label",
      definitionVersion: 2,
      enablementVersion: 3,
      assignmentVersion: 7,
    }),
  );

  assert.deepEqual(parsed.checkpoint, {
    threadId: "thread-1",
    labelId: "billing-label",
    definitionVersion: 2,
    enablementVersion: 3,
    assignmentVersion: 7,
  });

  const unassigned = parseHistoricalThreadLabelScanJob(
    workflowJob("label.thread.scan", {
      threadId: "thread-2",
      labelId: "billing-label",
      definitionVersion: 2,
      enablementVersion: 4,
      assignmentVersion: null,
    }),
  );

  assert.deepEqual(unassigned.checkpoint, {
    threadId: "thread-2",
    labelId: "billing-label",
    definitionVersion: 2,
    enablementVersion: 4,
    assignmentVersion: null,
  });
});
