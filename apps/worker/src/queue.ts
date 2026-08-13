import { Queue, Worker, type Job, type Processor } from "bullmq";
import IORedis from "ioredis";

import type { OutboxJob, QueueName, WorkflowStepJob } from "@invook/database";

export const queueNames: QueueName[] = [
  "gmail-pages",
  "gmail-messages",
  "gmail-control",
  "mail-indexing-batch",
  "mail-indexing-live",
  "mail-memory-submit",
  "mail-memory-events",
  "mail-memory-feedback",
  "mail-label-submit",
  "mail-label-events",
];

export type WorkflowJob = Job<WorkflowStepJob, Record<string, unknown>, string>;

export const gmailControlConcurrency = 5;

const completedJobRetention = { age: 7 * 24 * 60 * 60, count: 1_000 };
const failedJobRetention = { age: 30 * 24 * 60 * 60, count: 5_000 };

type WorkerRegistrationOptions = {
  concurrency?: number;
  lockDuration?: number;
  onTerminalFailure?: (job: WorkflowJob, error: Error) => Promise<void>;
  onTerminalFailureReconciliationError?: (error: Error) => void;
};

export class BullQueueRuntime {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue<WorkflowStepJob>>();
  private readonly workers: Worker[] = [];

  constructor(redisUrl: string) {
    if (!redisUrl.trim()) {
      throw new Error("REDIS_URL is required for BullMQ job processing.");
    }
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on("error", (error) => {
      console.error("worker: Redis connection error", {
        name: error.name,
        message: error.message,
      });
    });
    for (const queueName of queueNames) {
      this.queues.set(
        queueName,
        new Queue<WorkflowStepJob>(queueName, { connection: this.connection }),
      );
    }
  }

  onReady(listener: () => void) {
    this.connection.on("ready", listener);
    return () => this.connection.off("ready", listener);
  }

  async waitUntilReady() {
    const firstQueue = this.queues.values().next().value;
    if (!firstQueue) throw new Error("No BullMQ queues are configured.");
    await firstQueue.waitUntilReady();
  }

  async configureGlobalConcurrency() {
    const gmailMessages = this.queues.get("gmail-messages");
    if (!gmailMessages) throw new Error("The Gmail message queue is unavailable.");
    await gmailMessages.setGlobalConcurrency(5);
    const gmailControl = this.queues.get("gmail-control");
    if (!gmailControl) throw new Error("The Gmail control queue is unavailable.");
    await gmailControl.setGlobalConcurrency(gmailControlConcurrency);
  }

  async publish(jobs: OutboxJob[]) {
    const byQueue = new Map<QueueName, OutboxJob[]>();
    for (const job of jobs) {
      const queueJobs = byQueue.get(job.queueName) ?? [];
      queueJobs.push(job);
      byQueue.set(job.queueName, queueJobs);
    }

    for (const [queueName, queueJobs] of byQueue) {
      const queue = this.queues.get(queueName);
      if (!queue) throw new Error(`BullMQ queue is unavailable: ${queueName}`);
      await queue.addBulk(
        queueJobs.map((job) => {
          const runAt =
            typeof job.payload.runAt === "string"
              ? Date.parse(job.payload.runAt)
              : Number.NaN;
          const delay = Number.isFinite(runAt)
            ? Math.max(runAt - Date.now(), 0)
            : 0;
          return {
            name: job.stepType,
            data: {
              id: job.id,
              runId: job.runId,
              userId: job.userId,
              accountId: job.accountId,
              stepType: job.stepType,
              payload: job.payload,
              attempts: job.attempts,
              maxAttempts: job.maxAttempts,
            },
            opts: {
              jobId: job.id,
              attempts: Math.max(job.maxAttempts - job.attempts, 1),
              backoff: { type: "exponential", delay: 1_000 },
              ...(delay > 0 ? { delay } : {}),
              removeOnComplete: completedJobRetention,
              removeOnFail: failedJobRetention,
            },
          };
        }),
      );
    }
  }

  createWorker(
    queueName: QueueName,
    processor: Processor<WorkflowStepJob, Record<string, unknown>, string>,
    options: WorkerRegistrationOptions = {},
  ) {
    const {
      concurrency = 1,
      lockDuration,
      onTerminalFailure,
      onTerminalFailureReconciliationError,
    } = options;
    const worker = new Worker<WorkflowStepJob, Record<string, unknown>, string>(
      queueName,
      processor,
      {
        connection: this.connection,
        concurrency,
        ...(lockDuration ? { lockDuration } : {}),
      },
    );
    worker.on("error", (error) => {
      console.error("worker: BullMQ worker error", {
        queueName,
        name: error.name,
        message: error.message,
      });
    });
    worker.on("completed", (job) => {
      console.info("worker: BullMQ step completed", {
        queueName,
        stepId: job.id,
        stepType: job.name,
        attemptsMade: job.attemptsMade,
      });
    });
    worker.on("failed", (job, error) => {
      const configuredAttempts = job?.opts.attempts ?? 1;
      const terminal =
        error.name === "UnrecoverableError" ||
        Boolean(job && job.attemptsMade >= configuredAttempts);
      console.error("worker: BullMQ step failed", {
        queueName,
        stepId: job?.id,
        stepType: job?.name,
        attemptsMade: job?.attemptsMade,
        terminal,
        name: error.name,
        message: error.message,
      });
      if (terminal && job && onTerminalFailure) {
        void onTerminalFailure(job, error).catch((caught: unknown) => {
          const reconciliationError = caught instanceof Error
            ? caught
            : new Error("Unknown terminal failure reconciliation error.");
          console.error("worker: terminal failure reconciliation failed", {
            queueName,
            stepId: job.id,
            name: reconciliationError.name,
            message: reconciliationError.message,
          });
          onTerminalFailureReconciliationError?.(reconciliationError);
        });
      }
    });
    this.workers.push(worker);
    return worker;
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection.quit();
  }
}
