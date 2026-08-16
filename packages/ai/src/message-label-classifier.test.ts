import assert from "node:assert/strict";
import { test } from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import {
  createStoredMessageLabelClassifier,
  MessageLabelClassificationContractError,
  type StoredMessageLabelClassifierInput,
} from "./message-label-classifier";

const baseInput = {
  message: {
    subject: "Weekly product news",
    sender: "news@example.com",
    recipients: ["owner@example.com"],
    bodyText: "This week: three product launches and an unsubscribe link.",
  },
  labelDefinitions: [
    {
      id: "newsletter-label",
      name: "Newsletter",
      description: "Recurring editorial or promotional email publications.",
      definitionVersion: 3,
    },
    {
      id: "product-label",
      name: "Product updates",
      description: "News about product releases and feature launches.",
      definitionVersion: 7,
    },
  ],
} satisfies StoredMessageLabelClassifierInput;

function classifierWithOutput(output: unknown) {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    }),
  });
  return {
    model,
    classify: createStoredMessageLabelClassifier(() => ({
      model,
      modelId: "test/classifier-model",
    })),
  };
}

test("classifies every Invook definition in one structured call and allows multiple matches", async () => {
  const bodyPrefix = "x".repeat(6_000);
  const { classify, model } = classifierWithOutput({
    decisions: [
      { labelId: "product-label", matched: true, confidence: 88 },
      { labelId: "newsletter-label", matched: true, confidence: 97 },
    ],
  });

  const result = await classify({
    ...baseInput,
    message: {
      ...baseInput.message,
      bodyText: `${bodyPrefix}DO_NOT_INCLUDE_THIS_TAIL`,
    },
  });

  assert.equal(result.modelId, "test/classifier-model");
  assert.deepEqual(result.decisions, [
    {
      labelId: "newsletter-label",
      matched: true,
      confidence: 97,
      definitionVersion: 3,
    },
    {
      labelId: "product-label",
      matched: true,
      confidence: 88,
      definitionVersion: 7,
    },
  ]);
  assert.equal(model.doGenerateCalls.length, 1);

  const call = model.doGenerateCalls[0];
  assert.ok(call);
  assert.equal(call.responseFormat?.type, "json");
  const prompt = JSON.stringify(call.prompt);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /newsletter-label/);
  assert.match(prompt, /product-label/);
  assert.match(prompt, new RegExp(`x{${bodyPrefix.length}}`));
  assert.doesNotMatch(prompt, /DO_NOT_INCLUDE_THIS_TAIL/);
});

test("allows zero matching labels while preserving one decision per definition", async () => {
  const { classify } = classifierWithOutput({
    decisions: [
      { labelId: "newsletter-label", matched: false, confidence: 91 },
      { labelId: "product-label", matched: false, confidence: 84 },
    ],
  });

  const result = await classify(baseInput);

  assert.deepEqual(
    result.decisions.map(({ matched }) => matched),
    [false, false],
  );
});

test("rejects duplicate input definition IDs before calling a model", async () => {
  let modelCreationCount = 0;
  const unusedModel = classifierWithOutput({ decisions: [] }).model;
  const classify = createStoredMessageLabelClassifier(() => {
    modelCreationCount += 1;
    return { model: unusedModel, modelId: "unused" };
  });

  await assert.rejects(
    classify({
      ...baseInput,
      labelDefinitions: [
        baseInput.labelDefinitions[0],
        { ...baseInput.labelDefinitions[1], id: "newsletter-label" },
      ],
    }),
    (error: unknown) =>
      error instanceof MessageLabelClassificationContractError &&
      /Duplicate label definition ID/.test(error.message),
  );
  assert.equal(modelCreationCount, 0);
});

test("rejects duplicate, unknown, and missing model decision IDs", async (context) => {
  const invalidOutputs = [
    {
      name: "duplicate",
      decisions: [
        { labelId: "newsletter-label", matched: true, confidence: 90 },
        { labelId: "newsletter-label", matched: false, confidence: 70 },
      ],
      pattern: /Duplicate model decision/,
    },
    {
      name: "unknown",
      decisions: [
        { labelId: "newsletter-label", matched: true, confidence: 90 },
        { labelId: "unknown-label", matched: false, confidence: 70 },
      ],
      pattern: /Unknown model decision label ID/,
    },
    {
      name: "missing",
      decisions: [
        { labelId: "newsletter-label", matched: true, confidence: 90 },
      ],
      pattern: /Missing model decision for label ID/,
    },
  ];

  for (const invalidOutput of invalidOutputs) {
    await context.test(invalidOutput.name, async () => {
      const { classify } = classifierWithOutput({
        decisions: invalidOutput.decisions,
      });
      await assert.rejects(
        classify(baseInput),
        (error: unknown) =>
          error instanceof MessageLabelClassificationContractError &&
          invalidOutput.pattern.test(error.message),
      );
    });
  }
});
