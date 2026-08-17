import { fileURLToPath } from "node:url";

import {
  Client,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import { NativeConnection, Worker } from "@temporalio/worker";

import type { TemporalCommandJob } from "@invook/database";
import {
  workflowActivityTaskQueues,
  workflowStepWorkflow,
  type WorkflowActivityTaskQueue,
  type WorkflowStepActivities,
  type WorkflowStepExecution,
} from "@invook/workflows";

export const gmailControlConcurrency = 5;
export const gmailMessageConcurrency = parsePositiveInteger(
  process.env.GMAIL_MESSAGE_CONCURRENCY,
  5,
  "GMAIL_MESSAGE_CONCURRENCY",
);
export const mailLabelConcurrency = parsePositiveInteger(
  process.env.MAIL_LABEL_CONCURRENCY,
  5,
  "MAIL_LABEL_CONCURRENCY",
);

export interface TemporalCloudConfiguration {
  address: string;
  namespace: string;
  apiKey: string;
  taskQueuePrefix: string;
}

interface CreateTemporalRuntimeInput {
  activities: WorkflowStepActivities;
  enabledActivityTaskQueues: ReadonlySet<WorkflowActivityTaskQueue>;
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function requiredEnvironmentValue(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${name} is required for Temporal Cloud.`);
  return normalized;
}

export function getTemporalCloudConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): TemporalCloudConfiguration {
  const taskQueuePrefix = requiredEnvironmentValue(
    environment.TEMPORAL_TASK_QUEUE_PREFIX,
    "TEMPORAL_TASK_QUEUE_PREFIX",
  );
  if (!/^[a-z0-9][a-z0-9-]*$/.test(taskQueuePrefix)) {
    throw new Error(
      "TEMPORAL_TASK_QUEUE_PREFIX must contain lowercase letters, digits, and hyphens.",
    );
  }
  return {
    address: requiredEnvironmentValue(
      environment.TEMPORAL_ADDRESS,
      "TEMPORAL_ADDRESS",
    ),
    namespace: requiredEnvironmentValue(
      environment.TEMPORAL_NAMESPACE,
      "TEMPORAL_NAMESPACE",
    ),
    apiKey: requiredEnvironmentValue(
      environment.TEMPORAL_API_KEY,
      "TEMPORAL_API_KEY",
    ),
    taskQueuePrefix,
  };
}

function activityTaskQueueName(
  configuration: TemporalCloudConfiguration,
  activityTaskQueue: WorkflowActivityTaskQueue,
): string {
  return `${configuration.taskQueuePrefix}-${activityTaskQueue}`;
}

export function getWorkflowStartDelay(
  payload: Record<string, unknown>,
  now: number = Date.now(),
): number | undefined {
  if (typeof payload.runAt !== "string") return undefined;
  const runAt = Date.parse(payload.runAt);
  if (!Number.isFinite(runAt) || runAt <= now) return undefined;
  return runAt - now;
}

function activityConcurrency(
  activityTaskQueue: WorkflowActivityTaskQueue,
): number {
  switch (activityTaskQueue) {
    case "gmail-control":
      return gmailControlConcurrency;
    case "gmail-messages":
      return gmailMessageConcurrency;
    case "mail-indexing-live":
      return 5;
    case "mail-label-live":
    case "mail-label-submit":
      return mailLabelConcurrency;
    default:
      return 1;
  }
}

export class TemporalRuntime {
  private readonly client: Client;
  private readonly configuration: TemporalCloudConfiguration;
  private readonly connection: NativeConnection;
  private readonly workers: Worker[];
  private workerRun: Promise<void> | null = null;

  private constructor(input: {
    client: Client;
    configuration: TemporalCloudConfiguration;
    connection: NativeConnection;
    workers: Worker[];
  }) {
    this.client = input.client;
    this.configuration = input.configuration;
    this.connection = input.connection;
    this.workers = input.workers;
  }

  static async create(
    input: CreateTemporalRuntimeInput,
  ): Promise<TemporalRuntime> {
    const configuration = getTemporalCloudConfiguration();
    const connection = await NativeConnection.connect({
      address: configuration.address,
      apiKey: configuration.apiKey,
      tls: true,
    });
    const client = new Client({
      connection,
      namespace: configuration.namespace,
    });
    const workflowWorker = await Worker.create({
      connection,
      namespace: configuration.namespace,
      taskQueue: `${configuration.taskQueuePrefix}-workflows`,
      workflowsPath: fileURLToPath(
        new URL("./temporal-workflows.ts", import.meta.url),
      ),
    });
    const activityWorkers = await Promise.all(
      workflowActivityTaskQueues
        .filter((taskQueue) => input.enabledActivityTaskQueues.has(taskQueue))
        .map((taskQueue) =>
          Worker.create({
            activities: input.activities,
            connection,
            namespace: configuration.namespace,
            taskQueue: activityTaskQueueName(configuration, taskQueue),
            maxConcurrentActivityTaskExecutions:
              activityConcurrency(taskQueue),
          }),
        ),
    );
    return new TemporalRuntime({
      client,
      configuration,
      connection,
      workers: [workflowWorker, ...activityWorkers],
    });
  }

  async dispatch(commands: TemporalCommandJob[]): Promise<void> {
    await Promise.all(
      commands.map(async (command) => {
        const input: WorkflowStepExecution = {
          ...command,
          activityTaskQueue: activityTaskQueueName(
            this.configuration,
            command.activityTaskQueue,
          ),
        };
        try {
          const startDelay = getWorkflowStartDelay(command.payload);
          await this.client.workflow.start(workflowStepWorkflow, {
            args: [input],
            taskQueue: `${this.configuration.taskQueuePrefix}-workflows`,
            workflowId: `workflow-step:${command.id}`,
            workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
            ...(startDelay === undefined ? {} : { startDelay }),
          });
        } catch (error) {
          if (error instanceof WorkflowExecutionAlreadyStartedError) return;
          throw error;
        }
      }),
    );
  }

  run(): Promise<void> {
    if (!this.workerRun) {
      this.workerRun = Promise.all(
        this.workers.map((worker) => worker.run()),
      ).then(() => undefined);
    }
    return this.workerRun;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.shutdown()));
    if (this.workerRun) await this.workerRun;
    await this.connection.close();
  }
}
