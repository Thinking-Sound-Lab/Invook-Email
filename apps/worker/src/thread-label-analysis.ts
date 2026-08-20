import {
  AiConfigurationError,
  classifyStoredThreadLabel,
  ThreadLabelClassificationContractError,
} from "@invook/ai";
import {
  beginHistoricalThreadLabelScan,
  beginThreadLabelAnalysis,
  completeHistoricalThreadLabelScan,
  completeThreadLabelAnalysis,
  failThreadLabelAnalysis,
  type HistoricalThreadLabelCheckpoint,
  type ThreadLabelAnalysisCheckpoint,
  type WorkflowStepJob,
} from "@invook/database";

export type ThreadLabelAnalysisJob = {
  userId: string;
  accountId: string;
  checkpoint: ThreadLabelAnalysisCheckpoint;
};

export type HistoricalThreadLabelScanJob = {
  userId: string;
  accountId: string;
  checkpoint: HistoricalThreadLabelCheckpoint;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is missing.`);
  }
  return value;
}

function requiredSha256(value: unknown, name: string): string {
  const hash = requiredString(value, name);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, name: string): number | null {
  return value === null ? null : requiredPositiveInteger(value, name);
}

export function parseThreadLabelAnalysisJob(
  job: WorkflowStepJob,
): ThreadLabelAnalysisJob {
  if (job.stepType !== "label.thread.assign") {
    throw new Error(`Unsupported thread label step: ${job.stepType}`);
  }
  return {
    userId: requiredString(job.userId, "Thread label user ID"),
    accountId: requiredString(job.accountId, "Thread label account ID"),
    checkpoint: {
      threadId: requiredString(job.payload.threadId, "Thread label thread ID"),
      analysisVersion: requiredPositiveInteger(
        job.payload.analysisVersion,
        "Thread label analysis version",
      ),
      definitionHash: requiredSha256(
        job.payload.definitionHash,
        "Thread label definition hash",
      ),
    },
  };
}

export function parseHistoricalThreadLabelScanJob(
  job: WorkflowStepJob,
): HistoricalThreadLabelScanJob {
  if (job.stepType !== "label.thread.scan") {
    throw new Error(`Unsupported historical thread label step: ${job.stepType}`);
  }
  return {
    userId: requiredString(job.userId, "Historical label user ID"),
    accountId: requiredString(job.accountId, "Historical label account ID"),
    checkpoint: {
      threadId: requiredString(job.payload.threadId, "Historical label thread ID"),
      labelId: requiredString(job.payload.labelId, "Historical label ID"),
      definitionVersion: requiredPositiveInteger(
        job.payload.definitionVersion,
        "Historical label definition version",
      ),
      assignmentVersion: nullablePositiveInteger(
        job.payload.assignmentVersion,
        "Historical label assignment version",
      ),
    },
  };
}

function classifierThread(thread: {
  subject: string;
  messages: Array<{
    subject: string;
    sender: { raw: string };
    recipients: string[];
    bodyText: string;
    sentAt: Date;
  }>;
}) {
  return {
    subject: thread.subject,
    messages: thread.messages.map((message) => ({
      subject: message.subject,
      sender: message.sender.raw,
      recipients: message.recipients,
      bodyText: message.bodyText,
      sentAt: message.sentAt.toISOString(),
    })),
  };
}

export async function runThreadLabelAnalysis(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  const parsed = parseThreadLabelAnalysisJob(job);
  const analysis = await beginThreadLabelAnalysis(parsed);
  if (analysis.status !== "ready") {
    return { status: analysis.status, threadId: parsed.checkpoint.threadId };
  }
  const classification = await classifyStoredThreadLabel({
    thread: classifierThread(analysis.thread),
    labelDefinitions: analysis.definitions,
    fallbackLabelId: analysis.fallback.id,
  });
  const completion = await completeThreadLabelAnalysis({
    ...parsed,
    modelId: classification.modelId,
    labelId: classification.labelId,
    confidence: classification.confidence,
  });
  return { ...completion, threadId: parsed.checkpoint.threadId };
}

export async function runHistoricalThreadLabelScan(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  const parsed = parseHistoricalThreadLabelScanJob(job);
  const analysis = await beginHistoricalThreadLabelScan(parsed);
  if (analysis.status !== "ready") {
    return {
      status: analysis.status,
      threadId: parsed.checkpoint.threadId,
      labelId: parsed.checkpoint.labelId,
    };
  }
  const noMatchLabelId = `no-match:${analysis.definition.id}`;
  const classification = await classifyStoredThreadLabel({
    thread: classifierThread(analysis.thread),
    labelDefinitions: [analysis.definition],
    fallbackLabelId: noMatchLabelId,
  });
  const completion = await completeHistoricalThreadLabelScan({
    ...parsed,
    modelId: classification.modelId,
    matched: classification.labelId === analysis.definition.id,
    confidence: classification.confidence,
  });
  return {
    ...completion,
    threadId: parsed.checkpoint.threadId,
    labelId: parsed.checkpoint.labelId,
  };
}

export function isThreadLabelWorkflowStep(stepType: string): boolean {
  return stepType === "label.thread.assign" || stepType === "label.thread.scan";
}

export async function runLabelSubmission(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType === "label.thread.assign") return runThreadLabelAnalysis(job);
  if (job.stepType === "label.thread.scan") {
    return runHistoricalThreadLabelScan(job);
  }
  throw new Error(`Unsupported thread label step: ${job.stepType}`);
}

export function threadLabelAnalysisErrorCode(error: unknown): string {
  if (error instanceof AiConfigurationError) {
    return "label_analysis_model_unavailable";
  }
  if (error instanceof ThreadLabelClassificationContractError) {
    return "label_analysis_invalid_model_output";
  }
  return "label_analysis_failed";
}

export async function failTerminalThreadLabelAnalysis(
  job: WorkflowStepJob,
  error: unknown,
): Promise<boolean> {
  if (job.stepType !== "label.thread.assign") return false;
  let parsed: ThreadLabelAnalysisJob;
  try {
    parsed = parseThreadLabelAnalysisJob(job);
  } catch {
    return false;
  }
  return failThreadLabelAnalysis({
    ...parsed,
    errorCode: threadLabelAnalysisErrorCode(error),
  });
}
