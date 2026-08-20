import {
  classifyThreadLabelBatchFailure,
  createThreadLabelBatch,
  deleteThreadLabelBatchFiles,
  findThreadLabelBatchInputFileBySubmissionId,
  findThreadLabelBatchBySubmissionId,
  getThreadLabelBatchModelId,
  prepareThreadLabelBatch,
  readThreadLabelBatch,
  uploadThreadLabelBatchInput,
} from "@invook/ai";
import {
  claimThreadLabelBatchSubmission,
  finalizeThreadLabelBatchPreparation,
  finalizeThreadLabelBatchSubmission,
  getThreadLabelBatchSubmissionForStep,
  recordThreadLabelBatchInputFile,
  recordThreadLabelProviderBatch,
  type WorkflowStepJob,
} from "@invook/database";

const terminalBatchStates = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is missing.`);
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is missing.`);
  return value;
}

function optionalThreadIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) {
    throw new Error("Thread-label Batch retry thread IDs are invalid.");
  }
  const threadIds = Array.from(
    new Set(value.map((threadId) => requiredString(threadId, "Thread-label retry ID"))),
  );
  return threadIds;
}

export async function runThreadLabelBatchSubmission(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType !== "label.batch.submit" || !job.userId || !job.accountId) {
    throw new Error("The thread-label Batch submission identity is invalid.");
  }
  const flushRemainder = requiredBoolean(
    job.payload.flushRemainder,
    "Thread-label Batch flush flag",
  );
  const threadIds = optionalThreadIds(job.payload.threadIds);
  let submission = await getThreadLabelBatchSubmissionForStep(job.id);
  if (submission?.status === "complete" || submission?.status === "submitted") {
    return {
      status: submission.status,
      submissionId: submission.id,
      providerBatchId: submission.providerBatchId,
    };
  }
  const claimed = await claimThreadLabelBatchSubmission({
    workflowStepId: job.id,
    userId: job.userId,
    accountId: job.accountId,
    flushRemainder,
    modelId: getThreadLabelBatchModelId(),
    threadIds,
  });
  if (!claimed) return { status: "insufficient_candidates" };

  submission = await getThreadLabelBatchSubmissionForStep(job.id);
  if (!submission) throw new Error("The claimed thread-label Batch is unavailable.");
  let jsonl: string | null = null;
  if (!submission.inputFileId && !submission.providerBatchId) {
    const prepared = prepareThreadLabelBatch({ entries: claimed.candidates });
    if (prepared.manifest.length === 0) {
      throw new Error("The claimed thread-label Batch has no valid requests.");
    }
    const preparedThreadIds = new Set(
      prepared.manifest.map((entry) => entry.threadId),
    );
    submission = await finalizeThreadLabelBatchPreparation({
      submissionId: claimed.submissionId,
      manifest: prepared.manifest,
      excludedThreadIds: submission.manifest
        .map((entry) => entry.threadId)
        .filter((threadId) => !preparedThreadIds.has(threadId)),
    });
    jsonl = prepared.jsonl;
  }

  let inputFileId = submission.inputFileId;
  if (!inputFileId) {
    if (!jsonl) throw new Error("The prepared thread-label Batch input is unavailable.");
    const uploadedInputFileId =
      (await findThreadLabelBatchInputFileBySubmissionId(submission.id)) ??
      (await uploadThreadLabelBatchInput({
        submissionId: submission.id,
        jsonl,
      }));
    inputFileId = await recordThreadLabelBatchInputFile({
      submissionId: submission.id,
      inputFileId: uploadedInputFileId,
    });
  }

  let providerBatchId = submission.providerBatchId;
  if (!providerBatchId) {
    const existing = await findThreadLabelBatchBySubmissionId(submission.id);
    const providerBatch =
      existing ??
      (await createThreadLabelBatch({
        submissionId: submission.id,
        inputFileId,
      }));
    submission = await recordThreadLabelProviderBatch({
      submissionId: submission.id,
      providerBatchId: providerBatch.providerBatchId,
      inputFileId: providerBatch.inputFileId,
    });
    providerBatchId = submission.providerBatchId;
  }
  if (!providerBatchId) throw new Error("The OpenAI thread-label Batch has no identity.");

  return {
    status: "submitted",
    submissionId: submission.id,
    providerBatchId,
    requestCount: submission.requestCount,
    continuationStepId: null,
  };
}

export async function runThreadLabelBatchEvent(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType !== "label.batch.event") {
    throw new Error("The thread-label Batch event type is invalid.");
  }
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "Thread-label submission job ID",
  );
  const submission = await getThreadLabelBatchSubmissionForStep(submissionJobId);
  if (!submission || !submission.providerBatchId || !submission.inputFileId) {
    throw new Error("The thread-label Batch event could not be matched.");
  }
  if (
    requiredString(job.payload.providerBatchId, "Thread-label provider Batch ID") !==
    submission.providerBatchId
  ) {
    throw new Error("The thread-label Batch event provider identity is invalid.");
  }
  if (submission.status === "complete" || submission.status === "failed") {
    const undeletedFileIds = await deleteThreadLabelBatchFiles({
      inputFileId: submission.inputFileId,
      outputFileId: submission.outputFileId,
      errorFileId: submission.errorFileId,
    });
    return {
      status: "complete",
      submissionId: submission.id,
      appliedCount: 0,
      alreadyFinalized: true,
      continuationStepId: null,
      undeletedFileIds,
    };
  }
  const batch = await readThreadLabelBatch({
    providerBatchId: submission.providerBatchId,
    manifest: submission.manifest,
  });
  if (!terminalBatchStates.has(batch.state)) {
    throw new Error(
      `OpenAI emitted a terminal event while the thread-label Batch is ${batch.state}.`,
    );
  }
  const failure = classifyThreadLabelBatchFailure({
    providerState: batch.state,
    providerError: batch.providerError,
  });
  const completion = await finalizeThreadLabelBatchSubmission({
    submissionId: submission.id,
    providerState: batch.state,
    providerErrorCode: failure.errorCode,
    retryableFailure: failure.isRetryable,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
    modelId: batch.modelId,
    results: batch.results,
    failedThreadIds: batch.failedThreadIds,
  });
  const undeletedFileIds = await deleteThreadLabelBatchFiles({
    inputFileId: submission.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  return {
    status: "complete",
    submissionId: submission.id,
    appliedCount: completion.appliedCount,
    alreadyFinalized: completion.alreadyFinalized,
    continuationStepId: completion.continuationStepId,
    undeletedFileIds,
  };
}
