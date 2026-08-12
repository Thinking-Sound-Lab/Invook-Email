import { scheduler } from "node:timers/promises";

import { MAIL_EMBEDDING_DIMENSIONS } from "@invook/contracts";
import { getEncoding } from "js-tiktoken";
import OpenAI, { APIError, toFile } from "openai";
import type { Batch } from "openai/resources/batches";

const OPENAI_BATCH_REQUEST_LIMIT = 50_000;
const BATCH_FILE_LIMIT_BYTES = 200_000_000;
const OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT = 8_192;
const EMBEDDING_TOKENIZER_CHARACTER_LIMIT = 65_536;
const EVENT_LOOP_YIELD_INTERVAL = 25;
const embeddingEncoding = getEncoding("cl100k_base");

export type EmbeddingConfiguration = {
  modelId: string;
  dimensions: number;
};

export type EmbeddingBatchState = Batch["status"];

export type EmbeddingBatchManifestEntry = {
  key: string;
  messageId: string;
  contentHash: string;
};

export type PreparedEmbeddingBatch = EmbeddingConfiguration & {
  requestCount: number;
  manifest: EmbeddingBatchManifestEntry[];
  jsonl: string;
};

export class EmbeddingConfigurationError extends Error {
  constructor(
    message =
      "OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL, and OPENAI_EMBEDDING_DIMENSIONS are required for mailbox embeddings.",
  ) {
    super(message);
    this.name = "EmbeddingConfigurationError";
  }
}

function positiveInteger(value: string | undefined, name: string): number {
  const normalized = value?.trim() ?? "";
  const parsed = Number(normalized);
  if (!/^[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw new EmbeddingConfigurationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function configuration(): EmbeddingConfiguration & { apiKey: string } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const modelId = process.env.OPENAI_EMBEDDING_MODEL?.trim();
  if (!apiKey || !modelId) throw new EmbeddingConfigurationError();
  const dimensions = positiveInteger(
    process.env.OPENAI_EMBEDDING_DIMENSIONS,
    "OPENAI_EMBEDDING_DIMENSIONS",
  );
  if (dimensions !== MAIL_EMBEDDING_DIMENSIONS) {
    throw new EmbeddingConfigurationError(
      `OPENAI_EMBEDDING_DIMENSIONS must be ${MAIL_EMBEDDING_DIMENSIONS} for the mailbox vector index.`,
    );
  }
  return {
    apiKey,
    modelId,
    dimensions,
  };
}

function client(): OpenAI {
  return new OpenAI({ apiKey: configuration().apiKey });
}

function asConfiguration(
  value: EmbeddingConfiguration & { apiKey: string },
): EmbeddingConfiguration {
  return { modelId: value.modelId, dimensions: value.dimensions };
}

function configurationError(error: unknown): EmbeddingConfigurationError | null {
  if (!(error instanceof APIError)) return null;
  if (
    error.status === 401 ||
    error.status === 403 ||
    error.code === "insufficient_quota" ||
    error.code === "billing_hard_limit_reached"
  ) {
    return new EmbeddingConfigurationError(
      "OpenAI embeddings are unavailable. Verify the API key, model access, billing, and quota configuration, then restart the worker.",
    );
  }
  return null;
}

async function providerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const mapped = configurationError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

export function getEmbeddingConfiguration(): EmbeddingConfiguration {
  return asConfiguration(configuration());
}

export function isEmbeddingConfigured(): boolean {
  try {
    configuration();
    return true;
  } catch {
    return false;
  }
}

export function isEmbeddingBatchConfigured(): boolean {
  return Boolean(
    isEmbeddingConfigured() && process.env.OPENAI_WEBHOOK_SECRET?.trim(),
  );
}

export function buildEmbeddingInput(input: {
  subject: string;
  bodyText: string;
}): string {
  const text = `Subject: ${input.subject.trim()}\n\n${input.bodyText.trim()}`;
  const tokenizerInput = text.slice(0, EMBEDDING_TOKENIZER_CHARACTER_LIMIT);
  const tokens = embeddingEncoding.encode(tokenizerInput);
  return tokens.length <= OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT
    ? tokenizerInput
    : embeddingEncoding.decode(
        tokens.slice(0, OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT),
      );
}

export async function embedMailboxTexts(inputs: string[]): Promise<{
  modelId: string;
  dimensions: number;
  embeddings: number[][];
}> {
  const config = configuration();
  if (inputs.length === 0) {
    return { ...asConfiguration(config), embeddings: [] };
  }
  const result = await providerCall(() =>
    client().embeddings.create({
      model: config.modelId,
      dimensions: config.dimensions,
      encoding_format: "float",
      input: inputs,
    }),
  );
  const embeddings = [...result.data]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
  if (
    embeddings.length !== inputs.length ||
    embeddings.some(
      (embedding) =>
        embedding.length !== config.dimensions ||
        embedding.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("OpenAI returned an invalid mailbox embedding response.");
  }
  return { ...asConfiguration(config), embeddings };
}

export async function prepareEmbeddingBatch(input: {
  messages: Array<{
    messageId: string;
    contentHash: string;
    subject: string;
    bodyText: string;
  }>;
}): Promise<PreparedEmbeddingBatch | null> {
  if (!process.env.OPENAI_WEBHOOK_SECRET?.trim()) {
    throw new EmbeddingConfigurationError(
      "OPENAI_WEBHOOK_SECRET is required for OpenAI Batch embeddings.",
    );
  }
  if (input.messages.length === 0) return null;
  if (input.messages.length > OPENAI_BATCH_REQUEST_LIMIT) {
    throw new Error(
      `The embedding batch has ${input.messages.length} requests, above OpenAI's ${OPENAI_BATCH_REQUEST_LIMIT}-request file limit.`,
    );
  }

  const config = configuration();
  const accepted: Array<{
    message: (typeof input.messages)[number];
    line: string;
  }> = [];
  let fileSize = 0;
  for (const [index, message] of input.messages.entries()) {
    if (index > 0 && index % EVENT_LOOP_YIELD_INTERVAL === 0) {
      await scheduler.yield();
    }
    const line = JSON.stringify({
      custom_id: message.messageId,
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: config.modelId,
        dimensions: config.dimensions,
        encoding_format: "float",
        input: buildEmbeddingInput(message),
      },
    });
    const lineSize = Buffer.byteLength(`${line}\n`, "utf8");
    if (fileSize + lineSize > BATCH_FILE_LIMIT_BYTES) break;
    accepted.push({ message, line });
    fileSize += lineSize;
  }
  if (accepted.length === 0) {
    throw new Error("A single mailbox embedding request exceeds OpenAI's 200 MB file limit.");
  }
  const manifest = accepted.map(({ message }) => ({
    key: message.messageId,
    messageId: message.messageId,
    contentHash: message.contentHash,
  }));
  const jsonl = `${accepted.map(({ line }) => line).join("\n")}\n`;

  return {
    ...asConfiguration(config),
    requestCount: manifest.length,
    manifest,
    jsonl,
  };
}

export async function uploadEmbeddingBatchInput(input: {
  submissionId: string;
  jsonl: string;
}): Promise<string> {
  const uploaded = await providerCall(async () =>
    client().files.create({
      file: await toFile(
        Buffer.from(input.jsonl, "utf8"),
        `invook-embeddings-${input.submissionId}.jsonl`,
        { type: "application/jsonl" },
      ),
      purpose: "batch",
    }),
  );
  return uploaded.id;
}

export async function createEmbeddingBatch(input: {
  submissionId: string;
  inputFileId: string;
}): Promise<{ providerBatchId: string; inputFileId: string }> {
  const batch = await providerCall(() =>
    client().batches.create(
      {
        input_file_id: input.inputFileId,
        endpoint: "/v1/embeddings",
        completion_window: "24h",
        metadata: { invook_job_id: input.submissionId },
      },
      { idempotencyKey: input.submissionId },
    ),
  );
  return { providerBatchId: batch.id, inputFileId: input.inputFileId };
}

export async function findEmbeddingBatchBySubmissionId(
  submissionId: string,
): Promise<{ providerBatchId: string; inputFileId: string } | null> {
  configuration();
  const batches = client().batches.list({ limit: 100 });
  for await (const batch of batches) {
    if (batch.metadata?.invook_job_id !== submissionId) continue;
    return {
      providerBatchId: batch.id,
      inputFileId: batch.input_file_id,
    };
  }
  return null;
}

function customId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("custom_id" in value)) return null;
  return typeof value.custom_id === "string" && value.custom_id
    ? value.custom_id
    : null;
}

function responseEmbedding(value: unknown): number[] | null {
  if (!value || typeof value !== "object" || !("response" in value)) return null;
  const response = value.response;
  if (!response || typeof response !== "object") return null;
  const statusCode = "status_code" in response ? response.status_code : undefined;
  if (typeof statusCode !== "number" || statusCode < 200 || statusCode >= 300) {
    return null;
  }
  const body = "body" in response ? response.body : undefined;
  if (!body || typeof body !== "object") return null;
  const data = "data" in body ? body.data : undefined;
  if (!Array.isArray(data) || data.length !== 1) return null;
  const embedding = data[0];
  if (!embedding || typeof embedding !== "object" || !("embedding" in embedding)) {
    return null;
  }
  if (
    !Array.isArray(embedding.embedding) ||
    embedding.embedding.some(
      (item: unknown) => typeof item !== "number" || !Number.isFinite(item),
    )
  ) {
    return null;
  }
  return embedding.embedding as number[];
}

function responseErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const response = "response" in value ? value.response : undefined;
  if (response && typeof response === "object" && "body" in response) {
    const body = response.body;
    if (body && typeof body === "object" && "error" in body) {
      const error = body.error;
      if (error && typeof error === "object" && "message" in error) {
        return typeof error.message === "string" ? error.message.trim() : null;
      }
    }
  }
  const error = "error" in value ? value.error : undefined;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message.trim() : null;
  }
  return null;
}

async function readJsonlFile(openai: OpenAI, fileId: string): Promise<unknown[]> {
  const response = await openai.files.content(fileId);
  const contents = await response.text();
  return contents.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export async function readEmbeddingBatch(input: {
  providerBatchId: string;
  expectedKeys: string[];
  expectedDimensions: number;
}): Promise<{
  state: EmbeddingBatchState;
  outputFileId: string | null;
  errorFileId: string | null;
  embeddingsByKey: Map<string, number[]>;
  failedKeys: string[];
  providerError: string | null;
}> {
  configuration();
  const openai = client();
  const batch = await providerCall(() =>
    openai.batches.retrieve(input.providerBatchId),
  );
  const expectedKeys = new Set(input.expectedKeys);
  const embeddingsByKey = new Map<string, number[]>();
  const failedKeys = new Set<string>();
  const providerMessages = new Set<string>();

  if (batch.output_file_id) {
    for (const value of await providerCall(() =>
      readJsonlFile(openai, batch.output_file_id!),
    )) {
      const key = customId(value);
      if (!key || !expectedKeys.has(key)) continue;
      const embedding = responseEmbedding(value);
      if (!embedding || embedding.length !== input.expectedDimensions) {
        failedKeys.add(key);
      } else {
        embeddingsByKey.set(key, embedding);
      }
    }
  }
  if (batch.error_file_id) {
    for (const value of await providerCall(() =>
      readJsonlFile(openai, batch.error_file_id!),
    )) {
      const key = customId(value);
      if (key && expectedKeys.has(key)) failedKeys.add(key);
      const message = responseErrorMessage(value);
      if (message) providerMessages.add(message);
    }
  }
  for (const key of expectedKeys) {
    if (!embeddingsByKey.has(key)) failedKeys.add(key);
  }
  for (const error of batch.errors?.data ?? []) {
    const message = error.message?.trim();
    if (message) providerMessages.add(message);
  }
  return {
    state: batch.status,
    outputFileId: batch.output_file_id ?? null,
    errorFileId: batch.error_file_id ?? null,
    embeddingsByKey,
    failedKeys: [...failedKeys],
    providerError:
      providerMessages.size > 0 ? [...providerMessages].join("; ") : null,
  };
}

export async function getEmbeddingBatchState(
  providerBatchId: string,
): Promise<EmbeddingBatchState> {
  configuration();
  const batch = await providerCall(() =>
    client().batches.retrieve(providerBatchId),
  );
  return batch.status;
}

export async function deleteEmbeddingBatchInputFile(
  inputFileId: string,
): Promise<boolean> {
  const openai = client();
  try {
    await openai.files.delete(inputFileId);
    return true;
  } catch {
    return false;
  }
}
