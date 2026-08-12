import {
  getBatchRequestProgress,
  isAiConfigured,
  isMemoryBatchConfigured,
  memoryBatchProviders,
  type MemoryBatchProvider,
} from "@invook/ai";
import type {
  MailboxWorkspace,
  MemoryEntry,
  MemoryGenerationProgress,
  ReplyDraft,
} from "@invook/contracts";
import { getMailboxWorkspace } from "@invook/database";

function resultNumber(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

async function serializeMemoryProgress(
  workspace: NonNullable<Awaited<ReturnType<typeof getMailboxWorkspace>>>,
): Promise<MemoryGenerationProgress> {
  const memoryCount = workspace.memories.length;
  const submission = workspace.memoryBatchSubmission;
  const requestCount = resultNumber(submission, "requestCount");
  const evidenceMessageCount = resultNumber(submission, "evidenceMessageCount");

  if (
    workspace.account.syncState.mailSync === "pending" ||
    workspace.account.syncState.mailSync === "running"
  ) {
    return {
      stage: "waiting_for_mail",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: null,
      evidenceMessageCount,
      memoryCount,
    };
  }
  if (workspace.account.syncState.memory === "complete") {
    return {
      stage: "complete",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }
  if (workspace.account.syncState.memory === "failed") {
    return {
      stage: "failed",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }

  const provider = submission?.provider;
  const providerBatchId = submission?.providerBatchId;
  if (
    typeof provider !== "string" ||
    !memoryBatchProviders.includes(provider as MemoryBatchProvider) ||
    typeof providerBatchId !== "string" ||
    !providerBatchId
  ) {
    return {
      stage: "preparing",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }

  try {
    const progress = await getBatchRequestProgress({
      provider: provider as MemoryBatchProvider,
      providerBatchId,
    });
    const stage =
      progress.state === "validating"
        ? "validating"
        : progress.state === "in_progress"
          ? "analyzing"
          : progress.state === "finalizing" ||
              progress.state === "completed" ||
              progress.state === "cancelling"
            ? "finalizing"
            : "failed";

    return {
      stage,
      completedRequestCount: progress.completedRequestCount,
      failedRequestCount: progress.failedRequestCount,
      totalRequestCount: progress.totalRequestCount ?? requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  } catch {
    return {
      stage: "validating",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }
}

export async function serializeWorkspace(
  workspace: NonNullable<Awaited<ReturnType<typeof getMailboxWorkspace>>>,
): Promise<MailboxWorkspace> {
  return {
    aiConfigured: isAiConfigured(),
    batchConfigured: isMemoryBatchConfigured(),
    account: {
      ...workspace.account,
      lastSyncedAt: workspace.account.lastSyncedAt?.toISOString() ?? null,
    },
    memoryProgress: await serializeMemoryProgress(workspace),
    memories: workspace.memories,
    labels: workspace.labels,
    pagination: workspace.pagination,
    threads: workspace.threads.map((thread) => ({
      ...thread,
      latestMessageAt: thread.latestMessageAt?.toISOString() ?? null,
    })),
    selectedThread: workspace.selectedThread
      ? {
          ...workspace.selectedThread,
          latestMessageAt:
            workspace.selectedThread.latestMessageAt?.toISOString() ?? null,
          messages: workspace.selectedThread.messages.map((message) => ({
            ...message,
            sentAt: message.sentAt.toISOString(),
          })),
        }
      : null,
  };
}

export function serializeMemoryEntry(memory: {
  id: string;
  memoryType: MemoryEntry["type"];
  contactEmail: string | null;
  statement: string;
  source: MemoryEntry["source"];
  confidence: string | null;
  evidenceMessageIds: string[];
  evidenceDraftIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): MemoryEntry {
  return {
    id: memory.id,
    type: memory.memoryType,
    contactEmail: memory.contactEmail,
    statement: memory.statement,
    source: memory.source,
    confidence: memory.confidence === null ? null : Number(memory.confidence),
    evidenceMessageIds: memory.evidenceMessageIds,
    evidenceDraftIds: memory.evidenceDraftIds,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

export function serializeReplyDraft(draft: {
  id: string;
  threadId: string;
  status: ReplyDraft["status"];
  generatedText: string | null;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: Date;
}): ReplyDraft {
  if (!draft.generatedText) {
    throw new Error("A generated draft is missing its generated text.");
  }
  return {
    id: draft.id,
    threadId: draft.threadId,
    status: draft.status,
    generatedText: draft.generatedText,
    currentText: draft.currentText,
    usedMemoryIds: draft.usedMemoryIds,
    updatedAt: draft.updatedAt.toISOString(),
  };
}
