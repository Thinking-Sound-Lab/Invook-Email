import {
  AiConfigurationError,
  classifyStoredMessageLabels,
  MessageLabelClassificationContractError,
} from "@invook/ai";
import {
  beginMessageLabelAnalysis,
  completeMessageLabelAnalysis,
  failMessageLabelAnalysis,
  type MessageLabelAnalysisCheckpoint,
  type WorkflowStepJob,
} from "@invook/database";

type BeginMessageLabelAnalysisInput = Parameters<
  typeof beginMessageLabelAnalysis
>[0];
type BeginMessageLabelAnalysisResult = Awaited<
  ReturnType<typeof beginMessageLabelAnalysis>
>;
type CompleteMessageLabelAnalysisInput = Parameters<
  typeof completeMessageLabelAnalysis
>[0];
type CompleteMessageLabelAnalysisResult = Awaited<
  ReturnType<typeof completeMessageLabelAnalysis>
>;
type StoredMessageLabelClassifierInput = Parameters<
  typeof classifyStoredMessageLabels
>[0];
type StoredMessageLabelClassifierResult = Awaited<
  ReturnType<typeof classifyStoredMessageLabels>
>;
type FailMessageLabelAnalysisInput = Parameters<
  typeof failMessageLabelAnalysis
>[0];

export type MessageLabelAnalysisJob = {
  userId: string;
  accountId: string;
  checkpoint: MessageLabelAnalysisCheckpoint;
};

export type MessageLabelAnalysisDependencies = {
  begin: (
    input: BeginMessageLabelAnalysisInput,
  ) => Promise<BeginMessageLabelAnalysisResult>;
  classify: (
    input: StoredMessageLabelClassifierInput,
  ) => Promise<StoredMessageLabelClassifierResult>;
  complete: (
    input: CompleteMessageLabelAnalysisInput,
  ) => Promise<CompleteMessageLabelAnalysisResult>;
};

const defaultDependencies: MessageLabelAnalysisDependencies = {
  begin: (input) => beginMessageLabelAnalysis(input),
  classify: classifyStoredMessageLabels,
  complete: (input) => completeMessageLabelAnalysis(input),
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
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function parseMessageLabelAnalysisJob(
  job: WorkflowStepJob,
): MessageLabelAnalysisJob {
  if (job.stepType !== "label.message.analyze") {
    throw new Error(`Unsupported message label step: ${job.stepType}`);
  }
  return {
    userId: requiredString(job.userId, "Message label user ID"),
    accountId: requiredString(job.accountId, "Message label account ID"),
    checkpoint: {
      messageId: requiredString(job.payload.messageId, "Message label message ID"),
      contentHash: requiredSha256(
        job.payload.contentHash,
        "Message label content hash",
      ),
      analysisVersion: requiredPositiveInteger(
        job.payload.analysisVersion,
        "Message label analysis version",
      ),
      definitionHash: requiredSha256(
        job.payload.definitionHash,
        "Message label definition hash",
      ),
    },
  };
}

export function createRunMessageLabelAnalysis(
  dependencies: MessageLabelAnalysisDependencies = defaultDependencies,
): (job: WorkflowStepJob) => Promise<Record<string, unknown>> {
  return async (job) => {
    const parsed = parseMessageLabelAnalysisJob(job);
    const analysis = await dependencies.begin({
      userId: parsed.userId,
      accountId: parsed.accountId,
      checkpoint: parsed.checkpoint,
    });
    if (analysis.status !== "ready") {
      return {
        status: analysis.status,
        messageId: parsed.checkpoint.messageId,
      };
    }

    const classification = await dependencies.classify({
      message: {
        subject: analysis.message.subject,
        sender: analysis.message.sender.raw,
        recipients: analysis.message.recipients,
        bodyText: analysis.message.bodyText,
      },
      labelDefinitions: analysis.definitions,
    });
    const completion = await dependencies.complete({
      userId: parsed.userId,
      accountId: parsed.accountId,
      checkpoint: parsed.checkpoint,
      modelId: classification.modelId,
      decisions: classification.decisions,
    });
    return {
      ...completion,
      messageId: parsed.checkpoint.messageId,
    };
  };
}

export const runMessageLabelAnalysis = createRunMessageLabelAnalysis();

export function messageLabelAnalysisErrorCode(error: unknown): string {
  if (error instanceof AiConfigurationError) {
    return "label_analysis_model_unavailable";
  }
  if (error instanceof MessageLabelClassificationContractError) {
    return "label_analysis_invalid_model_output";
  }
  return "label_analysis_failed";
}

export async function failTerminalMessageLabelAnalysis(
  job: WorkflowStepJob,
  error: unknown,
  fail: (
    input: FailMessageLabelAnalysisInput,
  ) => Promise<boolean> = (input) => failMessageLabelAnalysis(input),
): Promise<boolean> {
  if (job.stepType !== "label.message.analyze") return false;

  let parsed: MessageLabelAnalysisJob;
  try {
    parsed = parseMessageLabelAnalysisJob(job);
  } catch {
    return false;
  }
  return fail({
    userId: parsed.userId,
    accountId: parsed.accountId,
    checkpoint: {
      messageId: parsed.checkpoint.messageId,
      contentHash: parsed.checkpoint.contentHash,
      analysisVersion: parsed.checkpoint.analysisVersion,
      definitionHash: parsed.checkpoint.definitionHash,
    },
    errorCode: messageLabelAnalysisErrorCode(error),
  });
}
