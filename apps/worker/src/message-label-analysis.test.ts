import assert from "node:assert/strict";
import { test } from "node:test";

import { AiConfigurationError } from "@invook/ai";
import type {
  MessageLabelAnalysisCheckpoint,
  WorkflowStepJob,
} from "@invook/database";

import {
  createRunHistoricalMessageLabelAnalysis,
  createRunMessageLabelAnalysis,
  failTerminalMessageLabelAnalysis,
  messageLabelAnalysisErrorCode,
  parseHistoricalMessageLabelAnalysisJob,
  parseMessageLabelAnalysisJob,
  type HistoricalMessageLabelAnalysisDependencies,
  type MessageLabelAnalysisDependencies,
} from "./message-label-analysis";

const CONTENT_HASH = "a".repeat(64);
const DEFINITION_HASH = "b".repeat(64);

function analysisJob(
  overrides: Partial<WorkflowStepJob> = {},
): WorkflowStepJob {
  return {
    id: "step-1",
    userId: "user-1",
    accountId: "account-1",
    runId: null,
    stepType: "label.message.analyze",
    payload: {
      messageId: "message-1",
      contentHash: CONTENT_HASH,
      analysisVersion: 3,
      definitionHash: DEFINITION_HASH,
    },
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

function historicalJob(
  overrides: Partial<WorkflowStepJob> = {},
): WorkflowStepJob {
  return {
    id: "step-2",
    userId: "user-1",
    accountId: "account-1",
    runId: null,
    stepType: "label.message.apply",
    payload: {
      messageId: "message-1",
      contentHash: CONTENT_HASH,
      labelId: "security-label",
      definitionVersion: 2,
    },
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

test("message label job payload requires every durable checkpoint", () => {
  assert.deepEqual(parseMessageLabelAnalysisJob(analysisJob()), {
    userId: "user-1",
    accountId: "account-1",
    checkpoint: {
      messageId: "message-1",
      contentHash: CONTENT_HASH,
      analysisVersion: 3,
      definitionHash: DEFINITION_HASH,
    },
  });
  assert.throws(
    () =>
      parseMessageLabelAnalysisJob(
        analysisJob({ payload: { messageId: "message-1" } }),
      ),
    /content hash is missing/i,
  );
  assert.throws(
    () =>
      parseMessageLabelAnalysisJob(
        analysisJob({
          payload: {
            messageId: "message-1",
            contentHash: "not-a-hash",
            analysisVersion: 3,
            definitionHash: DEFINITION_HASH,
          },
        }),
      ),
    /lowercase SHA-256 digest/i,
  );
});

test("analysis classifies only the stored message and current definitions", async () => {
  const calls: string[] = [];
  const dependencies: MessageLabelAnalysisDependencies = {
    async begin(input) {
      calls.push("begin");
      assert.equal(input.checkpoint.contentHash, CONTENT_HASH);
      return {
        status: "ready",
        message: {
          id: "message-1",
          subject: "Stored subject",
          sender: {
            raw: "Sender <sender@example.test>",
            email: "sender@example.test",
          },
          recipients: ["owner@example.test"],
          bodyText: "Stored body",
        },
        definitions: [
          {
            id: "newsletter",
            name: "Newsletter",
            description: "A recurring publication",
            definitionVersion: 1,
          },
          {
            id: "travel",
            name: "Travel",
            description: "Travel planning",
            definitionVersion: 2,
          },
        ],
      };
    },
    async classify(input) {
      calls.push("classify");
      assert.deepEqual(input.message, {
        subject: "Stored subject",
        sender: "Sender <sender@example.test>",
        recipients: ["owner@example.test"],
        bodyText: "Stored body",
      });
      assert.deepEqual(
        input.labelDefinitions.map((definition) => definition.id),
        ["newsletter", "travel"],
      );
      return {
        modelId: "model-1",
        decisions: [
          {
            labelId: "newsletter",
            matched: true,
            confidence: 92,
            definitionVersion: 1,
          },
          {
            labelId: "travel",
            matched: true,
            confidence: 81,
            definitionVersion: 2,
          },
        ],
      };
    },
    async complete(input) {
      calls.push("complete");
      assert.equal(input.modelId, "model-1");
      assert.equal(input.decisions.length, 2);
      return { status: "complete", eventId: "event-1" };
    },
  };

  const result = await createRunMessageLabelAnalysis(dependencies)(analysisJob());
  assert.deepEqual(calls, ["begin", "classify", "complete"]);
  assert.deepEqual(result, {
    status: "complete",
    eventId: "event-1",
    messageId: "message-1",
  });
});

test("historical label jobs carry identifiers and classify the stored message only", async () => {
  assert.deepEqual(parseHistoricalMessageLabelAnalysisJob(historicalJob()), {
    userId: "user-1",
    accountId: "account-1",
    checkpoint: {
      messageId: "message-1",
      contentHash: CONTENT_HASH,
      labelId: "security-label",
      definitionVersion: 2,
    },
  });

  const calls: string[] = [];
  const dependencies: HistoricalMessageLabelAnalysisDependencies = {
    async begin(input) {
      calls.push("begin");
      assert.equal(input.checkpoint.labelId, "security-label");
      return {
        status: "ready",
        message: {
          id: "message-1",
          subject: "Security notice",
          sender: {
            raw: "Security <security@example.test>",
            email: "security@example.test",
          },
          recipients: ["owner@example.test"],
          bodyText: "A stored account security alert",
        },
        definition: {
          id: "security-label",
          name: "Security",
          description: "Account security and authentication notices",
          definitionVersion: 2,
        },
      };
    },
    async classify(input) {
      calls.push("classify");
      assert.equal(input.message.bodyText, "A stored account security alert");
      assert.deepEqual(input.labelDefinitions.map(({ id }) => id), [
        "security-label",
      ]);
      return {
        modelId: "model-1",
        decisions: [
          {
            labelId: "security-label",
            matched: true,
            confidence: 94,
            definitionVersion: 2,
          },
        ],
      };
    },
    async complete(input) {
      calls.push("complete");
      assert.equal(input.decision.labelId, "security-label");
      return { status: "complete" };
    },
  };

  const result = await createRunHistoricalMessageLabelAnalysis(dependencies)(
    historicalJob(),
  );
  assert.deepEqual(calls, ["begin", "classify", "complete"]);
  assert.deepEqual(result, {
    status: "complete",
    messageId: "message-1",
    labelId: "security-label",
  });
});

test("missing, superseded, and current historical work no-op before the model", async () => {
  for (const status of ["missing", "superseded", "current"] as const) {
    let classified = false;
    const dependencies: HistoricalMessageLabelAnalysisDependencies = {
      async begin() {
        return { status };
      },
      async classify() {
        classified = true;
        throw new Error("The classifier must not run.");
      },
      async complete() {
        throw new Error("Completion must not run.");
      },
    };
    const result = await createRunHistoricalMessageLabelAnalysis(dependencies)(
      historicalJob(),
    );
    assert.deepEqual(result, {
      status,
      messageId: "message-1",
      labelId: "security-label",
    });
    assert.equal(classified, false);
  }
});

test("missing, deleted, superseded, and resolved work no-op before the model", async () => {
  for (const status of ["missing", "superseded", "resolved"] as const) {
    let classified = false;
    const dependencies: MessageLabelAnalysisDependencies = {
      async begin() {
        return { status };
      },
      async classify() {
        classified = true;
        throw new Error("The classifier must not run.");
      },
      async complete() {
        throw new Error("Completion must not run.");
      },
    };
    const result = await createRunMessageLabelAnalysis(dependencies)(analysisJob());
    assert.deepEqual(result, { status, messageId: "message-1" });
    assert.equal(classified, false);
  }
});

test("terminal failure uses the expected content checkpoint and a sanitized code", async () => {
  let failureInput: {
    userId: string;
    accountId: string;
    checkpoint: MessageLabelAnalysisCheckpoint;
    errorCode: string;
  } | undefined;
  const failed = await failTerminalMessageLabelAnalysis(
    analysisJob(),
    new Error("raw model response must not be persisted"),
    async (input) => {
      failureInput = input;
      return false;
    },
  );
  assert.equal(failed, false);
  assert.ok(failureInput);
  assert.deepEqual(failureInput, {
    userId: "user-1",
    accountId: "account-1",
    checkpoint: {
      messageId: "message-1",
      contentHash: CONTENT_HASH,
      analysisVersion: 3,
      definitionHash: DEFINITION_HASH,
    },
    errorCode: "label_analysis_failed",
  });
  assert.equal(
    messageLabelAnalysisErrorCode(new AiConfigurationError()),
    "label_analysis_model_unavailable",
  );
});

test("an invalid terminal job cannot fail an unrelated message", async () => {
  let called = false;
  const failed = await failTerminalMessageLabelAnalysis(
    analysisJob({ payload: {} }),
    new Error("failed"),
    async () => {
      called = true;
      return true;
    },
  );
  assert.equal(failed, false);
  assert.equal(called, false);
});
