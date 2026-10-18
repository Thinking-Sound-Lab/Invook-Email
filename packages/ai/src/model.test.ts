import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LABEL_MODEL,
  getAgentModel,
  getAiModel,
  isAiConfigured,
} from "./model";
import { getThreadLabelBatchModelId } from "./thread-label-batch";

function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => void,
): void {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]] as const),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("live and Batch label classification share one default model", () => {
  withEnvironment(
    {
      OPENAI_API_KEY: "test-key",
      OPENAI_WEBHOOK_SECRET: "test-secret",
      OPENAI_MODEL: undefined,
      OPENAI_LABEL_BATCH_MODEL: undefined,
    },
    () => {
      assert.equal(DEFAULT_LABEL_MODEL, "gpt-5.6-luna");
      assert.equal(getAiModel().modelId, DEFAULT_LABEL_MODEL);
      assert.equal(getThreadLabelBatchModelId(), DEFAULT_LABEL_MODEL);
    },
  );
});

test("each label path overrides its model independently", () => {
  withEnvironment(
    {
      OPENAI_API_KEY: "test-key",
      OPENAI_WEBHOOK_SECRET: "test-secret",
      OPENAI_MODEL: "live-override",
      OPENAI_LABEL_BATCH_MODEL: "batch-override",
    },
    () => {
      assert.equal(getAiModel().modelId, "live-override");
      assert.equal(getThreadLabelBatchModelId(), "batch-override");
    },
  );
});

test("mailbox analysis needs only the shared OpenAI credential", () => {
  withEnvironment({ OPENAI_API_KEY: "test-key", OPENAI_MODEL: undefined }, () => {
    assert.equal(isAiConfigured(), true);
  });
  withEnvironment({ OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined }, () => {
    assert.equal(isAiConfigured(), false);
    assert.throws(() => getAiModel(), /OPENAI_API_KEY is required/);
  });
});

test("the mail agent overrides its model without changing labeling", () => {
  withEnvironment(
    {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "live-override",
      OPENAI_AGENT_MODEL: undefined,
    },
    () => {
      assert.equal(getAgentModel().modelId, DEFAULT_LABEL_MODEL);
    },
  );
  withEnvironment(
    {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: undefined,
      OPENAI_AGENT_MODEL: "agent-override",
    },
    () => {
      assert.equal(getAgentModel().modelId, "agent-override");
      assert.equal(getAiModel().modelId, DEFAULT_LABEL_MODEL);
    },
  );
  withEnvironment({ OPENAI_API_KEY: undefined, OPENAI_AGENT_MODEL: undefined }, () => {
    assert.throws(() => getAgentModel(), /OPENAI_API_KEY is required/);
  });
});
