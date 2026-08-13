import type { AccountSyncStage, IndexingProgress } from "@invook/contracts";

export type IndexingPrerequisiteState = {
  accountStatus: "connected" | "reconnect_required" | "disconnected";
  mailSyncStage: AccountSyncStage;
  replicaState:
    | "pending"
    | "snapshotting"
    | "replaying"
    | "auditing"
    | "ready"
    | "repairing"
    | "failed"
    | "deleting";
};

export type EmbeddingContinuationDecision =
  | { stage: "complete"; continuation: null }
  | { stage: "failed"; continuation: null }
  | {
      stage: "running";
      continuation: {
        reason: "next" | "retry";
        includeFailed: boolean;
        batchAttempt: number;
      };
    };

export function areIndexingPrerequisitesReady(
  input: IndexingPrerequisiteState,
): boolean {
  return (
    input.accountStatus === "connected" &&
    input.mailSyncStage === "complete" &&
    input.replicaState === "ready"
  );
}

export function deriveIndexingProgress(input: {
  persistedStage: AccountSyncStage;
  prerequisites: IndexingPrerequisiteState;
  isModelConfigured: boolean;
  completedMessageCount: number;
  failedMessageCount: number;
  totalMessageCount: number;
}): IndexingProgress {
  const progress = {
    completedMessageCount: input.completedMessageCount,
    failedMessageCount: input.failedMessageCount,
    totalMessageCount: input.totalMessageCount,
  };
  if (!areIndexingPrerequisitesReady(input.prerequisites)) {
    const isWaitingForInitialReplica =
      input.persistedStage === "pending" &&
      input.prerequisites.accountStatus === "connected" &&
      input.prerequisites.mailSyncStage !== "failed" &&
      !["failed", "deleting"].includes(input.prerequisites.replicaState);
    return {
      state: isWaitingForInitialReplica ? "pending" : "failed",
      ...progress,
    };
  }
  if (!input.isModelConfigured) {
    return {
      state: input.persistedStage === "pending" ? "pending" : "failed",
      ...progress,
    };
  }
  if (input.completedMessageCount === input.totalMessageCount) {
    return { state: "complete", ...progress };
  }
  if (input.persistedStage === "complete") {
    return { state: "failed", ...progress };
  }
  return { state: input.persistedStage, ...progress };
}

export function decideEmbeddingContinuation(input: {
  prerequisites: IndexingPrerequisiteState;
  hasMore: boolean;
  incompleteMessageCount: number;
  failedMessageCount: number;
  batchAttempt: number;
  batchAttemptLimit: number;
}): EmbeddingContinuationDecision {
  if (!areIndexingPrerequisitesReady(input.prerequisites)) {
    return { stage: "failed", continuation: null };
  }
  if (input.incompleteMessageCount === 0) {
    return { stage: "complete", continuation: null };
  }
  if (input.failedMessageCount > 0) {
    return input.batchAttempt < input.batchAttemptLimit
      ? {
          stage: "running",
          continuation: {
            reason: "retry",
            includeFailed: true,
            batchAttempt: input.batchAttempt + 1,
          },
        }
      : { stage: "failed", continuation: null };
  }
  return {
    stage: "running",
    continuation: {
      reason: "next",
      includeFailed: false,
      batchAttempt: 1,
    },
  };
}

export function createBatchEventIdempotencyKey(input: {
  provider: "openai" | "azure-openai";
  webhookId: string;
}): string {
  return `${input.provider}.batch-event:${input.webhookId}`;
}
