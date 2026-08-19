import { GMAIL_SYNC_MESSAGE_BATCH_SIZE } from "@invook/database";

export interface GmailMessageBatchPayload {
  runId: string;
  providerMessageIds: string[];
}

export interface GmailMessageBatchFailure {
  providerMessageId: string;
  error: unknown;
}

export function parseGmailMessageBatchPayload(
  payload: Record<string, unknown>,
): GmailMessageBatchPayload {
  const runId = payload.runId;
  const providerMessageIds = payload.providerMessageIds;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new Error("Gmail message batch run ID is missing.");
  }
  if (
    !Array.isArray(providerMessageIds) ||
    providerMessageIds.length === 0 ||
    providerMessageIds.length > GMAIL_SYNC_MESSAGE_BATCH_SIZE ||
    providerMessageIds.some(
      (providerMessageId) =>
        typeof providerMessageId !== "string" || !providerMessageId.trim(),
    ) ||
    new Set(providerMessageIds).size !== providerMessageIds.length
  ) {
    throw new Error("Gmail message batch IDs are invalid.");
  }
  return { runId, providerMessageIds };
}

export async function processGmailMessageBatch(input: {
  providerMessageIds: string[];
  concurrency: number;
  processMessage: (providerMessageId: string) => Promise<void>;
}): Promise<{
  succeededMessageIds: string[];
  failures: GmailMessageBatchFailure[];
}> {
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error("Gmail message batch concurrency must be a positive integer.");
  }
  let nextIndex = 0;
  const succeededMessageIds: string[] = [];
  const failures: GmailMessageBatchFailure[] = [];
  const processNext = async (): Promise<void> => {
    while (nextIndex < input.providerMessageIds.length) {
      const providerMessageId = input.providerMessageIds[nextIndex];
      nextIndex += 1;
      if (!providerMessageId) return;
      try {
        await input.processMessage(providerMessageId);
        succeededMessageIds.push(providerMessageId);
      } catch (error) {
        failures.push({ providerMessageId, error });
      }
    }
  };
  const workerCount = Math.min(
    input.concurrency,
    input.providerMessageIds.length,
  );
  await Promise.all(
    Array.from({ length: workerCount }, () => processNext()),
  );
  const inputOrder = new Map(
    input.providerMessageIds.map((providerMessageId, index) => [
      providerMessageId,
      index,
    ]),
  );
  const orderFor = (providerMessageId: string): number =>
    inputOrder.get(providerMessageId) ?? Number.MAX_SAFE_INTEGER;
  succeededMessageIds.sort(
    (left, right) => orderFor(left) - orderFor(right),
  );
  failures.sort(
    (left, right) =>
      orderFor(left.providerMessageId) - orderFor(right.providerMessageId),
  );
  return { succeededMessageIds, failures };
}
