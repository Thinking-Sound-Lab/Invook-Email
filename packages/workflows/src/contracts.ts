export const tenantTaskQueueLanes = ["control", "live", "bulk"] as const;

export type TenantTaskQueueLane = (typeof tenantTaskQueueLanes)[number];

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
