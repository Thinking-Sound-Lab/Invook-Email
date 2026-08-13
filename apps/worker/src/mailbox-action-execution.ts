import type { MailboxActionOperation } from "@invook/contracts";

type ExecutionTarget = {
  id: string;
  status: "pending" | "executing" | "completed" | "failed" | "stale";
};

type ExecutionProposal = {
  id: string;
  operation: MailboxActionOperation;
  isLabelCurrent: boolean;
  targets: ExecutionTarget[];
};

type ClaimedTarget<Target extends ExecutionTarget> =
  | { state: "ready"; target: Target }
  | { state: "stale" | "skip"; target: Target | null };

export type MailboxActionExecutionDependencies<Target extends ExecutionTarget> = {
  load(): Promise<ExecutionProposal & { targets: Target[] } | null>;
  claim(target: Target, operation: MailboxActionOperation): Promise<ClaimedTarget<Target>>;
  execute(
    target: Target,
    operation: MailboxActionOperation,
  ): Promise<Record<string, unknown>>;
  shouldAbort?(error: unknown): boolean;
  complete(targetId: string, evidence: Record<string, unknown>): Promise<void>;
  fail(targetId: string, errorCode: string): Promise<void>;
  markRemainingStale(errorCode: string): Promise<void>;
  enqueueHistoryCatchup(): Promise<string>;
  finalize(): Promise<{
    status: "completed" | "partial_failure" | "failed";
    completedCount: number;
    failedCount: number;
  }>;
};

export class MailboxActionTargetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MailboxActionTargetError";
    this.code = code;
  }
}

export async function runMailboxActionExecution<Target extends ExecutionTarget>(
  dependencies: MailboxActionExecutionDependencies<Target>,
) {
  const proposal = await dependencies.load();
  if (!proposal) return { status: "inactive" as const };

  if (!proposal.isLabelCurrent) {
    await dependencies.markRemainingStale("gmail_label_stale");
    const finalized = await dependencies.finalize();
    return { ...finalized, historyStepId: null };
  }

  let hasCompletedProviderWrite = proposal.targets.some(
    (target) => target.status === "completed",
  );
  for (const target of proposal.targets) {
    const claim = await dependencies.claim(target, proposal.operation);
    if (claim.state !== "ready") continue;
    try {
      const evidence = await dependencies.execute(claim.target, proposal.operation);
      await dependencies.complete(claim.target.id, evidence);
      hasCompletedProviderWrite = true;
    } catch (error) {
      if (dependencies.shouldAbort?.(error)) throw error;
      const errorCode =
        error instanceof MailboxActionTargetError
          ? error.code
          : "provider_write_failed";
      await dependencies.fail(claim.target.id, errorCode);
    }
  }

  const historyStepId = hasCompletedProviderWrite
    ? await dependencies.enqueueHistoryCatchup()
    : null;
  const finalized = await dependencies.finalize();
  return { ...finalized, historyStepId };
}
