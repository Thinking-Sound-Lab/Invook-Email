import {
  isAiConfigured,
  isMemoryBatchConfigured,
} from "@invook/ai";
import type {
  MailboxWorkspace,
  MemoryEntry,
  AiReplyDraft,
  SignedInUser,
} from "@invook/contracts";
import {
  getIndexingProgressForAccount,
  getMailSyncProgressForAccount,
  getMailboxWorkspace,
  MAIL_INDEX_VERSION,
} from "@invook/database";

export async function serializeWorkspace(
  workspace: NonNullable<Awaited<ReturnType<typeof getMailboxWorkspace>>>,
  user: SignedInUser,
): Promise<MailboxWorkspace> {
  const [mailSyncProgress, indexingProgress] = await Promise.all([
    getMailSyncProgressForAccount({ accountId: workspace.account.id }),
    getIndexingProgressForAccount({
      accountId: workspace.account.id,
      modelId: process.env.OPENAI_EMBEDDING_MODEL?.trim() || null,
      indexVersion: MAIL_INDEX_VERSION,
    }),
  ]);
  if (!mailSyncProgress || !indexingProgress) {
    throw new Error("The account synchronization state is unavailable.");
  }
  return {
    aiConfigured: isAiConfigured(),
    batchConfigured: isMemoryBatchConfigured(),
    user,
    account: {
      id: workspace.account.id,
      email: workspace.account.email,
      image: workspace.account.image,
      status: workspace.account.status,
      syncState: {
        ...workspace.account.syncState,
        indexing: indexingProgress.state,
      },
      mailSyncProgress,
      indexingProgress,
      lastSyncedAt: workspace.account.lastSyncedAt?.toISOString() ?? null,
      replica: {
        state: workspace.account.replicaState,
        readyAt: workspace.account.replicaReadyAt?.toISOString() ?? null,
      },
    },
    memories: workspace.memories,
    gmailUserLabels: workspace.gmailUserLabels,
    invookLabels: workspace.invookLabels,
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
            internalDate: message.internalDate.toISOString(),
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
  threadId: string | null;
  status: AiReplyDraft["status"];
  generatedText: string | null;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: Date;
}): AiReplyDraft {
  if (!draft.threadId || !draft.generatedText) {
    throw new Error("A generated draft is missing its local thread contract.");
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
