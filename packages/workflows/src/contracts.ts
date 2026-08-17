export const workflowActivityTaskQueues = [
  "gmail-pages",
  "gmail-messages",
  "gmail-control",
  "mail-indexing-batch",
  "mail-indexing-live",
  "mail-memory-submit",
  "mail-memory-events",
  "mail-memory-feedback",
  "mail-label-live",
  "mail-label-submit",
] as const;

export type WorkflowActivityTaskQueue = (typeof workflowActivityTaskQueues)[number];

export interface WorkflowStepExecution {
  id: string;
  userId: string | null;
  accountId: string | null;
  runId: string | null;
  stepType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  activityTaskQueue: string;
}

export interface WorkflowStepResult {
  result: Record<string, unknown>;
}

export interface WorkflowStepActivities {
  runWorkflowStepActivity(input: WorkflowStepExecution): Promise<WorkflowStepResult>;
  reconcileWorkflowStepFailureActivity(input: WorkflowStepExecution): Promise<void>;
}
