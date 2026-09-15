export type GmailHistoryCatchupDisposition =
  | "complete"
  | "continue_durably"
  | "superseded";

type GmailReplicaState =
  | "pending"
  | "snapshotting"
  | "replaying"
  | "ready"
  | "repairing"
  | "failed"
  | "deleting";

export type GmailHistoryCatchupPlan =
  | {
      kind: "apply";
      expectedCursor: string;
      startHistoryId: string;
      stateAfterApply: "ready" | "snapshotting" | "repairing";
      ingestionMode: "initial" | "incremental";
      shouldRepairExpiredCursor: boolean;
    }
  | {
      kind: "defer";
      state: Exclude<GmailReplicaState, "ready">;
    };

/**
 * Replay starts at the later of the run baseline and the committed cursor.
 * Live catch-up during snapshot/repair advances `historyCursor`; listing from
 * the original baseline after that can 404 once Gmail expires it.
 */
export function gmailHistoryReplayStart(input: {
  expectedCursor: string;
  baselineHistoryId: string;
}): string {
  return BigInt(input.expectedCursor) > BigInt(input.baselineHistoryId)
    ? input.expectedCursor
    : input.baselineHistoryId;
}

export function planGmailSyncFinalizeReplay(input: {
  historyCursor: string | null;
  initialHistoryId: string;
  startingHistoryCursor: string;
}): { expectedCursor: string; startHistoryId: string } {
  const expectedCursor = input.historyCursor ?? input.initialHistoryId;
  return {
    expectedCursor,
    startHistoryId: gmailHistoryReplayStart({
      expectedCursor,
      baselineHistoryId: input.startingHistoryCursor,
    }),
  };
}

export function planGmailHistoryCatchup(input: {
  replicaState: GmailReplicaState;
  initialHistoryId: string;
  historyCursor: string | null;
  repairStartingHistoryCursor?: string | null;
}): GmailHistoryCatchupPlan {
  const expectedCursor = input.historyCursor ?? input.initialHistoryId;
  if (input.replicaState === "ready") {
    return {
      kind: "apply",
      expectedCursor,
      startHistoryId: expectedCursor,
      stateAfterApply: "ready",
      ingestionMode: "incremental",
      shouldRepairExpiredCursor: true,
    };
  }
  if (input.replicaState === "snapshotting") {
    return {
      kind: "apply",
      expectedCursor,
      startHistoryId: expectedCursor,
      stateAfterApply: "snapshotting",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    };
  }
  if (input.replicaState === "repairing" && input.repairStartingHistoryCursor) {
    return {
      kind: "apply",
      expectedCursor,
      startHistoryId: gmailHistoryReplayStart({
        expectedCursor,
        baselineHistoryId: input.repairStartingHistoryCursor,
      }),
      stateAfterApply: "repairing",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    };
  }
  return { kind: "defer", state: input.replicaState };
}

export function gmailHistoryCatchupDisposition(input: {
  applied: boolean;
  pendingHistoryCursor: string | null;
}): GmailHistoryCatchupDisposition {
  if (!input.applied) return "superseded";
  return input.pendingHistoryCursor ? "continue_durably" : "complete";
}
