import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowStepJob } from "@invook/database";

import {
  parseHistoricalThreadLabelScanJob,
  parseThreadLabelAnalysisJob,
} from "./thread-label-analysis";

const DEFINITION_HASH = "a".repeat(64);

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

test("thread assignment jobs require the durable thread and definition checkpoints", () => {
  const parsed = parseThreadLabelAnalysisJob(
    workflowJob("label.thread.assign", {
      threadId: "thread-1",
      analysisVersion: 3,
      definitionHash: DEFINITION_HASH,
    }),
  );

  assert.deepEqual(parsed.checkpoint, {
    threadId: "thread-1",
    analysisVersion: 3,
    definitionHash: DEFINITION_HASH,
  });
  assert.throws(
    () =>
      parseThreadLabelAnalysisJob(
        workflowJob("label.thread.assign", {
          threadId: "thread-1",
          analysisVersion: 3,
          definitionHash: "invalid",
        }),
      ),
    /lowercase SHA-256 digest/,
  );
});

test("historical scans accept assigned and unassigned thread checkpoints", () => {
  const parsed = parseHistoricalThreadLabelScanJob(
    workflowJob("label.thread.scan", {
      threadId: "thread-1",
      labelId: "billing-label",
      definitionVersion: 2,
      assignmentVersion: 7,
    }),
  );

  assert.deepEqual(parsed.checkpoint, {
    threadId: "thread-1",
    labelId: "billing-label",
    definitionVersion: 2,
    assignmentVersion: 7,
  });

  const unassigned = parseHistoricalThreadLabelScanJob(
    workflowJob("label.thread.scan", {
      threadId: "thread-2",
      labelId: "billing-label",
      definitionVersion: 2,
      assignmentVersion: null,
    }),
  );

  assert.deepEqual(unassigned.checkpoint, {
    threadId: "thread-2",
    labelId: "billing-label",
    definitionVersion: 2,
    assignmentVersion: null,
  });
});
