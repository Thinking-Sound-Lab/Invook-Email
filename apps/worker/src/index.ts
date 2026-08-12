import {
  AiConfigurationError,
  buildEmbeddingInput,
  createEmbeddingBatch,
  deleteEmbeddingBatchInputFile,
  deleteMemoryBatchFiles,
  embedMailboxTexts,
  extractFeedbackMemories,
  findEmbeddingBatchBySubmissionId,
  getEmbeddingBatchState,
  getEmbeddingConfiguration,
  isAnyMemoryBatchProviderConfigured,
  isAiConfigured,
  isEmbeddingBatchConfigured,
  isEmbeddingConfigured,
  isMemoryBatchConfigured,
  isMemoryBatchProviderConfigured,
  batchProviders,
  MemoryBatchConfigurationError,
  readEmbeddingBatch,
  readMemoryBatch,
  prepareEmbeddingBatch,
  submitMemoryBatch,
  uploadEmbeddingBatchInput,
  type FeedbackMemoryCandidate,
  type MemoryAnalysisThread,
  type MemoryBatchManifestEntry,
  type BatchProvider,
  type MessageMemoryCandidate,
} from "@invook/ai";
import {
  completeMailSyncItem,
  completeMailSyncRun,
  completeEmbeddingBatchSubmission,
  completeWorkflowStep,
  countFailedEmbeddings,
  decryptGoogleCredential,
  DRAFT_FEEDBACK_VERSION,
  encryptGoogleCredential,
  enqueueBatchEvent,
  enqueueEmbeddingBackfillContinuation,
  enqueueMemoryBatchRetry,
  enqueueMissingMailSyncRuns,
  enqueuePostSyncWorkflowSteps,
  enqueueReadyMailSyncFinalizers,
  failMailSyncItem,
  failMailSyncRun,
  failWorkflowStep,
  getActiveEmbeddingBatchSubmissionForAccount,
  getEmbeddingCandidates,
  getEmbeddingBatchSubmissionForStep,
  getDraftFeedbackSamples,
  getMemoryAnalysisThreads,
  getBatchSubmission,
  getUserAuthoredMemories,
  getWorkerAccount,
  hasCompletedMailSyncPage,
  listenForOutboxNotifications,
  MAIL_INDEX_VERSION,
  listSubmittedEmbeddingBatchIds,
  markMailSyncItemRunning,
  markWorkflowStepRunning,
  MEMORY_SCHEMA_VERSION,
  markDraftFeedbackAnalyzed,
  markEmbeddingBatchSubmitted,
  markMessageEmbeddingsFailed,
  countIncompleteEmbeddings,
  saveMessageEmbeddings,
  saveExtractedMemories,
  setIndexingSyncStage,
  setMemorySyncStage,
  publishOutboxBatch,
  prepareEmbeddingBatchSubmission,
  recordEmbeddingBatchInputFile,
  recordEmbeddingProviderBatch,
  recordMailSyncPage,
  refreshPreparingEmbeddingBatchSubmission,
  startMailSyncRun,
  updateStoredCredential,
  upsertMailboxMessage,
  type GoogleCredential,
  type MemoryType,
  type WorkflowStepJob,
} from "@invook/database";
import {
  extractEmailAddress,
  getGmailMessage,
  getGmailProfile,
  GmailApiError,
  isMemoryEligible,
  listGmailMessages,
  parseGmailMessage,
  refreshGoogleAccessToken,
  type ParsedGmailMessage,
} from "@invook/gmail";

import { BullQueueRuntime, type WorkflowJob } from "./queue";

const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
const feedbackBatchSize = 24;
const embeddingBatchRequestLimit = 2_000;
const embeddingBatchAttemptLimit = 3;
const batchWorkerLockDuration = 5 * 60 * 1_000;
const terminalEmbeddingBatchStates = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

function createJobSignal() {
  let pending = false;
  let release: (() => void) | null = null;

  return {
    notify() {
      pending = true;
      if (release) {
        const currentRelease = release;
        release = null;
        currentRelease();
      }
    },
    wait() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        release = () => {
          pending = false;
          resolve();
        };
      });
    },
  };
}

function normalizedEmails(values: string[], ownerEmail: string): string[] {
  return Array.from(
    new Set(
      values
        .map(extractEmailAddress)
        .filter((email) => email.includes("@") && email !== ownerEmail.toLowerCase()),
    ),
  );
}

async function refreshCredentialIfRequired(
  accountId: string,
  credential: GoogleCredential,
): Promise<GoogleCredential> {
  const expiresSoon = Date.parse(credential.expiresAt) <= Date.now() + 60_000;
  if (!expiresSoon) return credential;

  if (!googleClientId || !googleClientSecret) {
    throw new Error(
      "The worker needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to refresh Gmail access.",
    );
  }

  const refreshed = await refreshGoogleAccessToken({
    refreshToken: credential.refreshToken,
    clientId: googleClientId,
    clientSecret: googleClientSecret,
  });
  const nextCredential: GoogleCredential = {
    ...credential,
    accessToken: refreshed.accessToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
    scopes: refreshed.scope?.split(" ").filter(Boolean) ?? credential.scopes,
  };

  await updateStoredCredential(
    accountId,
    encryptGoogleCredential(nextCredential, encryptionKey),
  );

  return nextCredential;
}

async function storeMessage(options: {
  userId: string;
  accountId: string;
  accountEmail: string;
  message: ParsedGmailMessage;
}) {
  const { userId, accountId, accountEmail, message } = options;
  const direction =
    message.labelIds.includes("SENT") ||
    extractEmailAddress(message.from) === accountEmail.toLowerCase()
      ? "outgoing"
      : "incoming";

  await upsertMailboxMessage({
    userId,
    accountId,
    providerThreadId: message.providerThreadId,
    providerMessageId: message.providerMessageId,
    subject: message.subject,
    snippet: message.snippet,
    participants: [message.from, ...message.to, ...message.cc].filter(Boolean),
    labelIds: message.labelIds,
    sentAt: new Date(message.sentAt),
    direction,
    sender: { raw: message.from, email: extractEmailAddress(message.from) },
    recipients: [...message.to, ...message.cc],
    bodyText: message.bodyText,
    isMemoryEligible: direction === "outgoing" && isMemoryEligible(message),
    attachments: message.attachments,
  });
}

async function getMailSyncContext(accountId: string) {
  const account = await getWorkerAccount(accountId);
  if (!account) throw new Error("The connected Gmail account or credential was not found.");
  const storedCredential = decryptGoogleCredential(account.tokenCiphertext, encryptionKey);
  const credential = await refreshCredentialIfRequired(accountId, storedCredential);
  return { account, credential };
}

async function runGmailPage(job: WorkflowStepJob) {
  if (!job.accountId || !job.userId || !job.runId) {
    throw new Error("The Gmail page job is missing its synchronization run.");
  }
  const runId = requiredString(job.payload.runId, "Gmail synchronization run ID");
  const pageNumber = requiredInteger(job.payload.pageNumber, "Gmail page number");
  const rawPageToken = job.payload.pageToken;
  if (rawPageToken !== null && rawPageToken !== undefined && typeof rawPageToken !== "string") {
    throw new Error("The Gmail page token is invalid.");
  }
  if (await hasCompletedMailSyncPage(runId, pageNumber)) {
    return { status: "current", runId, pageNumber };
  }

  await startMailSyncRun(runId);
  const { account, credential } = await getMailSyncContext(job.accountId);
  const page = await listGmailMessages(credential.accessToken, {
    maxResults: 100,
    pageToken: rawPageToken ?? undefined,
  });
  const providerMessageIds = (page.messages ?? []).map((message) => message.id);
  await recordMailSyncPage({
    runId,
    userId: account.userId,
    accountId: account.id,
    pageNumber,
    pageToken: rawPageToken ?? null,
    nextPageToken: page.nextPageToken ?? null,
    providerMessageIds,
  });
  return {
    status: "complete",
    runId,
    pageNumber,
    discoveredMessageCount: providerMessageIds.length,
    hasNextPage: Boolean(page.nextPageToken),
  };
}

async function runGmailMessage(job: WorkflowStepJob) {
  if (!job.accountId || !job.runId) {
    throw new Error("The Gmail message job is missing its synchronization run.");
  }
  const runId = requiredString(job.payload.runId, "Gmail synchronization run ID");
  const providerMessageId = requiredString(
    job.payload.providerMessageId,
    "Gmail message ID",
  );
  const shouldProcess = await markMailSyncItemRunning(
    runId,
    providerMessageId,
    job.attempts,
  );
  if (!shouldProcess) {
    return { status: "current", runId, providerMessageId };
  }
  const { account, credential } = await getMailSyncContext(job.accountId);
  const gmailMessage = await getGmailMessage(credential.accessToken, providerMessageId);
  await storeMessage({
    userId: account.userId,
    accountId: account.id,
    accountEmail: account.email,
    message: parseGmailMessage(gmailMessage),
  });
  await completeMailSyncItem(runId, providerMessageId);
  return { status: "complete", runId, providerMessageId };
}

async function runGmailFinalize(job: WorkflowStepJob) {
  if (!job.accountId || !job.runId) {
    throw new Error("The Gmail finalization job is missing its synchronization run.");
  }
  const runId = requiredString(job.payload.runId, "Gmail synchronization run ID");
  const { credential } = await getMailSyncContext(job.accountId);
  const gmailProfile = await getGmailProfile(credential.accessToken);
  await completeMailSyncRun({ runId, finalHistoryCursor: gmailProfile.historyId });
  return { status: "complete", runId, historyCursor: gmailProfile.historyId };
}

async function runEmbeddingBackfill(job: WorkflowStepJob) {
  if (!job.accountId || !job.userId) {
    throw new Error("The embedding backfill has no connected account.");
  }
  const config = getEmbeddingConfiguration();
  const batchAttempt =
    job.payload.batchAttempt === undefined
      ? 1
      : requiredInteger(job.payload.batchAttempt, "embedding batch attempt");
  await setIndexingSyncStage(job.accountId, "running");
  let submission = await getEmbeddingBatchSubmissionForStep(job.id);
  let preparedBatch: Awaited<ReturnType<typeof prepareEmbeddingBatch>> = null;

  if (!submission) {
    const activeSubmission = await getActiveEmbeddingBatchSubmissionForAccount(
      job.accountId,
    );
    if (activeSubmission) {
      return {
        status: "deferred",
        activeSubmissionId: activeSubmission.id,
        activeProviderBatchId: activeSubmission.providerBatchId,
      };
    }
  }

  if (!submission?.inputFileId && !submission?.providerBatchId) {
    const candidates = await getEmbeddingCandidates({
      accountId: job.accountId,
      modelId: config.modelId,
      indexVersion: MAIL_INDEX_VERSION,
      limit: embeddingBatchRequestLimit + 1,
      includeFailed: job.payload.includeFailed !== false,
    });
    if (candidates.length === 0) {
      const incompleteCount = await countIncompleteEmbeddings({
        accountId: job.accountId,
        modelId: config.modelId,
        indexVersion: MAIL_INDEX_VERSION,
      });
      if (submission) {
        await completeEmbeddingBatchSubmission({
          submissionId: submission.id,
          providerState: "not_submitted",
          error: null,
        });
      }
      await setIndexingSyncStage(
        job.accountId,
        incompleteCount === 0 ? "complete" : "failed",
      );
      return {
        status: incompleteCount === 0 ? "complete" : "failed",
        incompleteCount,
      };
    }

    const batchCandidates = candidates.slice(0, embeddingBatchRequestLimit);
    preparedBatch = await prepareEmbeddingBatch({ messages: batchCandidates });
    if (!preparedBatch) {
      await setIndexingSyncStage(job.accountId, "complete");
      return { status: "complete", requestCount: 0 };
    }
    const hasMore =
      candidates.length > embeddingBatchRequestLimit ||
      preparedBatch.requestCount < batchCandidates.length;
    submission = submission
      ? await refreshPreparingEmbeddingBatchSubmission({
          submissionId: submission.id,
          modelId: preparedBatch.modelId,
          dimensions: preparedBatch.dimensions,
          indexVersion: MAIL_INDEX_VERSION,
          batchAttempt,
          hasMore,
          manifest: preparedBatch.manifest,
        })
      : await prepareEmbeddingBatchSubmission({
          workflowStepId: job.id,
          userId: job.userId,
          accountId: job.accountId,
          modelId: preparedBatch.modelId,
          dimensions: preparedBatch.dimensions,
          indexVersion: MAIL_INDEX_VERSION,
          batchAttempt,
          hasMore,
          manifest: preparedBatch.manifest,
        });
  }
  if (!submission) {
    const activeSubmission = await getActiveEmbeddingBatchSubmissionForAccount(
      job.accountId,
    );
    if (activeSubmission) {
      return {
        status: "deferred",
        activeSubmissionId: activeSubmission.id,
        activeProviderBatchId: activeSubmission.providerBatchId,
      };
    }
    throw new Error("The embedding batch submission is unavailable.");
  }
  if (submission.status === "failed") {
    throw new Error(submission.lastError ?? "The embedding batch submission failed.");
  }

  const hadRecordedInputFile = Boolean(submission.inputFileId);
  let inputFileId = submission.inputFileId;
  if (!inputFileId) {
    if (!preparedBatch) {
      throw new Error("The prepared embedding batch input is unavailable.");
    }
    const uploadedInputFileId = await uploadEmbeddingBatchInput({
      submissionId: submission.id,
      jsonl: preparedBatch.jsonl,
    });
    inputFileId = await recordEmbeddingBatchInputFile({
      submissionId: submission.id,
      inputFileId: uploadedInputFileId,
    });
  }

  let providerBatchId = submission.providerBatchId;
  if (!providerBatchId) {
    const recovered = hadRecordedInputFile
      ? await findEmbeddingBatchBySubmissionId(submission.id)
      : null;
    const providerBatch =
      recovered ??
      (await createEmbeddingBatch({
        submissionId: submission.id,
        inputFileId,
      }));
    submission = await recordEmbeddingProviderBatch({
      submissionId: submission.id,
      providerBatchId: providerBatch.providerBatchId,
      inputFileId: providerBatch.inputFileId,
    });
    providerBatchId = submission.providerBatchId;
  }
  if (!providerBatchId || !submission.inputFileId) {
    throw new Error("The OpenAI embedding batch is missing its provider identity.");
  }

  await markEmbeddingBatchSubmitted({
    accountId: job.accountId,
    modelId: submission.modelId,
    dimensions: submission.dimensions,
    indexVersion: MAIL_INDEX_VERSION,
    providerBatchId,
    messages: submission.manifest.map((entry) => ({
      messageId: entry.messageId,
      userId: job.userId!,
      contentHash: entry.contentHash,
    })),
  });
  return {
    status: "submitted",
    batchPurpose: "embedding",
    provider: submission.provider,
    providerBatchId,
    inputFileId: submission.inputFileId,
    modelId: submission.modelId,
    dimensions: submission.dimensions,
    requestCount: submission.requestCount,
    manifest: submission.manifest,
    indexVersion: MAIL_INDEX_VERSION,
    hasMore: submission.hasMore,
    batchAttempt: submission.batchAttempt,
  };
}

async function runIncrementalEmbedding(job: WorkflowStepJob) {
  if (!job.accountId) {
    throw new Error("The incremental embedding job has no connected account.");
  }
  const messageId = requiredString(job.payload.messageId, "message ID");
  const config = getEmbeddingConfiguration();
  const candidates = await getEmbeddingCandidates({
    accountId: job.accountId,
    modelId: config.modelId,
    indexVersion: MAIL_INDEX_VERSION,
    messageIds: [messageId],
  });
  if (candidates.length === 0) return { status: "current", messageId };

  const result = await embedMailboxTexts(
    candidates.map((candidate) => buildEmbeddingInput(candidate)),
  );
  const savedCount = await saveMessageEmbeddings({
    accountId: job.accountId,
    modelId: result.modelId,
    dimensions: result.dimensions,
    indexVersion: MAIL_INDEX_VERSION,
    values: candidates.map((candidate, index) => ({
      messageId: candidate.messageId,
      userId: candidate.userId,
      contentHash: candidate.contentHash,
      embedding: result.embeddings[index]!,
    })),
  });
  const incompleteCount = await countIncompleteEmbeddings({
    accountId: job.accountId,
    modelId: result.modelId,
    indexVersion: MAIL_INDEX_VERSION,
  });
  if (incompleteCount === 0) await setIndexingSyncStage(job.accountId, "complete");
  return { status: "complete", messageId, savedCount, incompleteCount };
}

async function runEmbeddingBatchEvent(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The embedding batch event has no account.");
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "embedding submission job ID",
  );
  const submission = await getEmbeddingBatchSubmissionForStep(submissionJobId);
  if (
    !submission ||
    submission.accountId !== job.accountId ||
    !["submitted", "complete"].includes(submission.status)
  ) {
    throw new Error("The embedding batch submission could not be matched.");
  }
  if (
    job.payload.provider !== submission.provider ||
    job.payload.providerBatchId !== submission.providerBatchId
  ) {
    throw new Error("The provider event does not match its embedding submission.");
  }
  if (!submission.providerBatchId || !submission.inputFileId) {
    throw new Error("The embedding batch submission is missing provider files.");
  }
  const batch = await readEmbeddingBatch({
    providerBatchId: submission.providerBatchId,
    expectedKeys: submission.manifest.map((entry) => entry.key),
    expectedDimensions: submission.dimensions,
  });
  const terminalState = ["completed", "failed", "cancelled", "expired"].includes(
    batch.state,
  );
  if (!terminalState) {
    throw new Error(
      `OpenAI emitted a terminal event while the embedding batch is ${batch.state}.`,
    );
  }

  const manifestByKey = new Map(
    submission.manifest.map((entry) => [entry.key, entry]),
  );
  const savedCount = await saveMessageEmbeddings({
    accountId: submission.accountId,
    modelId: submission.modelId,
    dimensions: submission.dimensions,
    indexVersion: submission.indexVersion,
    values: [...batch.embeddingsByKey].flatMap(([key, embedding]) => {
      const entry = manifestByKey.get(key);
      return entry
        ? [{
            messageId: entry.messageId,
            userId: submission.userId,
            contentHash: entry.contentHash,
            embedding,
          }]
        : [];
    }),
  });
  const failedEntries = batch.failedKeys.flatMap((key) => {
    const entry = manifestByKey.get(key);
    return entry ? [{ messageId: entry.messageId, contentHash: entry.contentHash }] : [];
  });
  if (failedEntries.length > 0) {
    await markMessageEmbeddingsFailed({
      modelId: submission.modelId,
      indexVersion: submission.indexVersion,
      values: failedEntries,
      error: batch.providerError ?? `OpenAI embedding batch ended as ${batch.state}.`,
    });
  }

  await completeEmbeddingBatchSubmission({
    submissionId: submission.id,
    providerState: batch.state,
    error: batch.providerError,
  });

  const [incompleteCount, failedCount, submittedBatchIds] = await Promise.all([
    countIncompleteEmbeddings({
      accountId: submission.accountId,
      modelId: submission.modelId,
      indexVersion: submission.indexVersion,
    }),
    countFailedEmbeddings({
      accountId: submission.accountId,
      modelId: submission.modelId,
      indexVersion: submission.indexVersion,
    }),
    listSubmittedEmbeddingBatchIds({ accountId: submission.accountId }),
  ]);
  const continuationJobIds: string[] = [];
  const providerCapacityAvailable = submittedBatchIds.length === 0;
  const continueFailedEmbeddings =
    providerCapacityAvailable &&
    failedCount > 0 &&
    (failedEntries.length === 0 ||
      submission.batchAttempt < embeddingBatchAttemptLimit);
  if (continueFailedEmbeddings) {
    const retryJobId = await enqueueEmbeddingBackfillContinuation({
      userId: submission.userId,
      accountId: submission.accountId,
      modelId: submission.modelId,
      indexVersion: submission.indexVersion,
      predecessorBatchId: submission.providerBatchId,
      includeFailed: true,
      batchAttempt:
        failedEntries.length > 0 ? submission.batchAttempt + 1 : 1,
      reason: "retry",
    });
    if (retryJobId) continuationJobIds.push(retryJobId);
  } else if (providerCapacityAvailable && failedCount === 0 && incompleteCount > 0) {
    const nextJobId = await enqueueEmbeddingBackfillContinuation({
      userId: submission.userId,
      accountId: submission.accountId,
      modelId: submission.modelId,
      indexVersion: submission.indexVersion,
      predecessorBatchId: submission.providerBatchId,
      includeFailed: false,
      batchAttempt: 1,
      reason: "next",
    });
    if (nextJobId) continuationJobIds.push(nextJobId);
  }
  const indexingStage =
    incompleteCount === 0
      ? "complete"
      : submittedBatchIds.length > 0 || continuationJobIds.length > 0
        ? "running"
        : "failed";
  await setIndexingSyncStage(submission.accountId, indexingStage);

  const inputFileDeleted = await deleteEmbeddingBatchInputFile(
    submission.inputFileId,
  );
  if (!inputFileDeleted) {
    console.error("worker: embedding batch input file could not be deleted", {
      submissionJobId: submission.id,
    });
  }
  return {
    status:
      indexingStage === "complete"
        ? "complete"
        : indexingStage === "failed"
          ? "failed"
          : "continuing",
    providerState: batch.state,
    providerError: batch.providerError,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
    batchAttempt: submission.batchAttempt,
    savedCount,
    failedRequestCount: failedEntries.length,
    incompleteCount,
    continuationJobIds,
  };
}

type StoredMemoryThread = Awaited<ReturnType<typeof getMemoryAnalysisThreads>>[number];

type MemorySubmissionResult = {
  provider: BatchProvider;
  providerBatchId: string;
  inputFileId: string;
  modelId: string;
  requestCount: number;
  manifest: MemoryBatchManifestEntry[];
  batchAttempt: number;
  rootSubmissionJobId: string;
  replaceExisting: boolean;
};

function toMemoryAnalysisThreads(
  threads: StoredMemoryThread[],
  ownerEmail: string,
): MemoryAnalysisThread[] {
  return threads.map((thread) => ({
    id: thread.id,
    subject: thread.subject,
    messages: thread.messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      sender: extractEmailAddress(message.sender.raw || message.sender.email),
      recipients: normalizedEmails(message.recipients, ownerEmail),
      bodyText: message.bodyText,
      sentAt: message.sentAt.toISOString(),
      ownerEvidence: message.ownerEvidence,
    })),
  }));
}

function parseManifest(value: unknown): MemoryBatchManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("The Memory batch manifest is missing.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("The Memory batch manifest is invalid.");
    }
    const key = "key" in entry ? entry.key : undefined;
    const mode = "mode" in entry ? entry.mode : undefined;
    const contactEmail = "contactEmail" in entry ? entry.contactEmail : undefined;
    const messageIds = "messageIds" in entry ? entry.messageIds : undefined;
    if (
      typeof key !== "string" ||
      (mode !== "global" && mode !== "contact") ||
      (contactEmail !== null && typeof contactEmail !== "string") ||
      !Array.isArray(messageIds) ||
      messageIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("The Memory batch manifest is invalid.");
    }
    if (mode === "contact" && !contactEmail) {
      throw new Error("A contact Memory batch scope has no contact address.");
    }
    if (mode === "global" && contactEmail !== null) {
      throw new Error("A global Memory batch scope cannot have a contact address.");
    }
    return { key, mode, contactEmail, messageIds };
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing from the Memory batch job.`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} is invalid in the Memory batch job.`);
  }
  return value;
}

function parseSubmissionResult(value: unknown): MemorySubmissionResult | null {
  if (!value || typeof value !== "object") {
    throw new Error("The Memory Batch submission result is missing.");
  }
  const result = value as Record<string, unknown>;
  if (!batchProviders.includes(result.provider as BatchProvider)) {
    return null;
  }
  const provider = result.provider as BatchProvider;
  if (typeof result.replaceExisting !== "boolean") {
    throw new Error("The Memory Batch replacement state is missing.");
  }
  const manifest = parseManifest(result.manifest);
  const requestCount = requiredInteger(
    result.requestCount,
    "Memory Batch request count",
  );
  if (
    manifest.length !== requestCount ||
    new Set(manifest.map((entry) => entry.key)).size !== manifest.length
  ) {
    throw new Error(
      "The Memory Batch manifest does not match its request count.",
    );
  }
  return {
    provider,
    providerBatchId: requiredString(
      result.providerBatchId,
      "provider batch ID",
    ),
    inputFileId: requiredString(result.inputFileId, "provider input file"),
    modelId: requiredString(result.modelId, "Memory Batch model"),
    requestCount,
    manifest,
    batchAttempt: requiredInteger(
      result.batchAttempt,
      "Memory Batch attempt",
    ),
    rootSubmissionJobId: requiredString(
      result.rootSubmissionJobId,
      "Root Memory submission job ID",
    ),
    replaceExisting: result.replaceExisting,
  };
}

function deduplicateCandidates(candidates: MessageMemoryCandidate[]) {
  const unique = new Map<string, MessageMemoryCandidate>();
  for (const candidate of candidates) {
    const statement = candidate.statement.trim().replace(/\s+/g, " ");
    const key = [
      candidate.type,
      candidate.contactEmail ?? "",
      statement.toLowerCase(),
    ].join(":");
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...candidate, statement });
      continue;
    }
    unique.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, candidate.confidence),
      evidenceMessageIds: Array.from(
        new Set([...existing.evidenceMessageIds, ...candidate.evidenceMessageIds]),
      ),
    });
  }
  return Array.from(unique.values());
}

function validateBatchCandidates(input: {
  candidates: MessageMemoryCandidate[];
  manifest: MemoryBatchManifestEntry;
  messagesById: Map<string, MemoryAnalysisThread["messages"][number]>;
}): MessageMemoryCandidate[] {
  const allowedMessageIds = new Set(input.manifest.messageIds);
  const targetContact = input.manifest.contactEmail?.toLowerCase() ?? null;
  const valid: MessageMemoryCandidate[] = [];

  for (const candidate of input.candidates) {
    const evidenceMessageIds = Array.from(new Set(candidate.evidenceMessageIds));
    const evidence = evidenceMessageIds.map((id) => input.messagesById.get(id));
    if (
      evidenceMessageIds.length < 3 ||
      evidenceMessageIds.some((id) => !allowedMessageIds.has(id)) ||
      evidence.some((message) => !message?.ownerEvidence)
    ) {
      continue;
    }

    if (input.manifest.mode === "contact") {
      if (candidate.type !== "contact" || !targetContact) continue;
      if (
        evidence.some(
          (message) =>
            !message?.recipients.some(
              (recipient) => recipient.toLowerCase() === targetContact,
            ),
        )
      ) {
        continue;
      }
      valid.push({ ...candidate, contactEmail: targetContact, evidenceMessageIds });
      continue;
    }

    if (candidate.type === "contact") continue;
    if (candidate.type === "preference") {
      const contacts = new Set(
        evidence.flatMap((message) => message?.recipients ?? []),
      );
      if (contacts.size < 3) continue;
    }
    valid.push({ ...candidate, contactEmail: null, evidenceMessageIds });
  }

  return valid;
}

async function runMemoryExtraction(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The memory job has no connected account.");
  if (job.payload.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return {
      status: "superseded",
      requestedSchemaVersion: job.payload.schemaVersion ?? null,
      currentSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }
  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");

  const indexedThreads = await getMemoryAnalysisThreads(account.id);
  const threads = toMemoryAnalysisThreads(indexedThreads, account.email);
  const evidenceMessageCount = threads.reduce(
    (total, thread) =>
      total + thread.messages.filter((message) => message.ownerEvidence).length,
    0,
  );
  if (evidenceMessageCount < 3) {
    await saveExtractedMemories({
      userId: account.userId,
      accountId: account.id,
      source: "inferred",
      modelId: null,
      memories: [],
    });
    return {
      status: "complete",
      threadCount: threads.length,
      evidenceMessageCount,
      memoryCount: 0,
    };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  await setMemorySyncStage(account.id, "running");
  const submission = await submitMemoryBatch({
    submissionId: job.id,
    batchAttempt: 1,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
  });
  if (!submission) {
    await saveExtractedMemories({
      userId: account.userId,
      accountId: account.id,
      source: "inferred",
      modelId: null,
      memories: [],
    });
    return {
      status: "complete",
      threadCount: threads.length,
      evidenceMessageCount,
      memoryCount: 0,
    };
  }

  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    replaceExisting: true,
    threadCount: threads.length,
    evidenceMessageCount,
  };
}

async function runMemoryBatchRetry(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Memory retry has no connected account.");
  const parentSubmissionJobId = requiredString(
    job.payload.parentSubmissionJobId,
    "Parent Memory submission job ID",
  );
  const parentSubmission = await getBatchSubmission(parentSubmissionJobId);
  if (parentSubmission?.accountId !== job.accountId) {
    throw new Error("The parent Memory submission could not be matched to this account.");
  }
  const parentDetails = parseSubmissionResult(parentSubmission.result);
  if (!parentDetails) {
    return { status: "superseded", provider: "unsupported" };
  }

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  if (!isMemoryBatchProviderConfigured(parentDetails.provider)) {
    throw new MemoryBatchConfigurationError(
      `The ${parentDetails.provider} provider used by this Memory Batch retry is not configured.`,
    );
  }

  const batchAttempt = requiredInteger(
    job.payload.batchAttempt,
    "Memory Batch attempt",
  );
  const rootSubmissionJobId = requiredString(
    job.payload.rootSubmissionJobId,
    "Root Memory submission job ID",
  );
  if (typeof job.payload.replaceExisting !== "boolean") {
    throw new Error("The Memory retry replacement state is missing.");
  }
  const manifest = parseManifest(job.payload.manifest);
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id),
    account.email,
  );
  const submission = await submitMemoryBatch({
    provider: parentDetails.provider,
    submissionId: job.id,
    batchAttempt,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    retryManifest: manifest,
  });
  if (!submission) {
    throw new Error("The Memory Batch retry produced no requests.");
  }

  return {
    status: "submitted",
    ...submission,
    batchAttempt,
    rootSubmissionJobId,
    replaceExisting: job.payload.replaceExisting,
  };
}

async function runMemoryBatchEvent(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Memory batch event has no account.");
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "Memory submission job ID",
  );
  const submission = await getBatchSubmission(submissionJobId);
  if (!submission?.accountId || !submission.userId || submission.accountId !== job.accountId) {
    throw new Error("The Memory Batch submission could not be matched to this account.");
  }
  const details = parseSubmissionResult(submission.result);
  if (!details) {
    return { status: "superseded", provider: "unsupported" };
  }
  const providerBatchId = requiredString(
    job.payload.providerBatchId,
    "provider event batch ID",
  );
  if (job.payload.provider !== details.provider) {
    throw new Error("The provider event does not match its Memory submission.");
  }
  if (providerBatchId !== details.providerBatchId) {
    throw new Error("The provider event does not match its Memory submission.");
  }

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id),
    account.email,
  );
  const messagesById = new Map(
    threads.flatMap((thread) =>
      thread.messages.map((message) => [message.id, message] as const),
    ),
  );
  const batch = await readMemoryBatch({
    provider: details.provider,
    providerBatchId: details.providerBatchId,
    modelId: details.modelId,
    expectedKeys: details.manifest.map((entry) => entry.key),
  });
  const terminalState =
    batch.state === "completed" ||
    batch.state === "failed" ||
    batch.state === "cancelled" ||
    batch.state === "expired";
  if (!terminalState) {
    throw new Error(
      `${details.provider} emitted a terminal event while the batch is ${batch.state}.`,
    );
  }

  const failedKeys = new Set(batch.failedKeys);
  const candidates: MessageMemoryCandidate[] = [];
  for (const entry of details.manifest) {
    if (failedKeys.has(entry.key)) continue;
    candidates.push(
      ...validateBatchCandidates({
        candidates: batch.candidatesByKey.get(entry.key) ?? [],
        manifest: entry,
        messagesById,
      }),
    );
  }
  const memories = deduplicateCandidates(candidates);
  const failedManifest = details.manifest.filter((entry) => failedKeys.has(entry.key));
  const hasSuccessfulRequests = failedManifest.length < details.manifest.length;

  if (hasSuccessfulRequests) {
    await saveExtractedMemories({
      userId: submission.userId,
      accountId: submission.accountId,
      source: "inferred",
      modelId: batch.modelId,
      memories,
      replaceExisting: details.replaceExisting,
      markComplete: failedManifest.length === 0,
    });
  }

  let retryJobId: string | null = null;
  if (failedManifest.length > 0 && details.batchAttempt < submission.maxAttempts) {
    retryJobId = await enqueueMemoryBatchRetry({
      userId: submission.userId,
      accountId: submission.accountId,
      parentSubmissionJobId: submission.id,
      rootSubmissionJobId: details.rootSubmissionJobId,
      batchAttempt: details.batchAttempt + 1,
      replaceExisting: hasSuccessfulRequests ? false : details.replaceExisting,
      manifest: failedManifest,
    });
  } else if (failedManifest.length > 0) {
    await setMemorySyncStage(submission.accountId, "failed");
  } else if (!hasSuccessfulRequests) {
    await setMemorySyncStage(submission.accountId, "complete");
  }

  const cleanupFailures = await deleteMemoryBatchFiles({
    provider: details.provider,
    inputFileId: details.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  if (cleanupFailures.length > 0) {
    console.error("worker: Memory Batch files could not be deleted", {
      provider: details.provider,
      submissionJobId: submission.id,
      fileCount: cleanupFailures.length,
    });
  }

  return {
    status:
      failedManifest.length === 0
        ? "complete"
        : retryJobId
          ? "retry_submitted"
          : "failed",
    providerState: batch.state,
    provider: details.provider,
    providerError: batch.providerError,
    candidateCount: candidates.length,
    memoryCount: memories.length,
    failedRequestCount: failedManifest.length,
    retryJobId,
  };
}

async function runMemoryFeedback(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The feedback job has no connected account.");
  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");

  const samples = await getDraftFeedbackSamples(
    account.id,
    DRAFT_FEEDBACK_VERSION,
    feedbackBatchSize,
  );
  if (samples.length < 3) {
    return { status: "waiting_for_repetition", sampleCount: samples.length };
  }
  if (!isAiConfigured()) throw new AiConfigurationError();

  const protectedMemories = await getUserAuthoredMemories(account.id);
  const analysis = await extractFeedbackMemories({
    protectedMemories,
    samples: samples.flatMap((sample) =>
      sample.generatedText
        ? [
            {
              id: sample.id,
              subject: sample.subject,
              contactEmails: normalizedEmails(sample.participants, account.email),
              generatedText: sample.generatedText,
              editedText: sample.editedText,
            },
          ]
        : [],
    ),
  });

  const samplesById = new Map(samples.map((sample) => [sample.id, sample]));
  const validMemories: FeedbackMemoryCandidate[] = [];
  for (const memory of analysis.memories) {
    const evidenceDraftIds = Array.from(new Set(memory.evidenceDraftIds));
    if (
      evidenceDraftIds.length < 3 ||
      evidenceDraftIds.some((id) => !samplesById.has(id))
    ) {
      continue;
    }

    if (memory.type === "contact") {
      const contactEmail = memory.contactEmail?.trim().toLowerCase();
      if (!contactEmail) continue;
      const repeatedForContact = evidenceDraftIds.every((id) => {
        const sample = samplesById.get(id);
        return Boolean(
          sample && normalizedEmails(sample.participants, account.email).includes(contactEmail),
        );
      });
      if (!repeatedForContact) continue;
      validMemories.push({ ...memory, contactEmail, evidenceDraftIds });
      continue;
    }

    if (memory.type === "preference") {
      const contacts = new Set(
        evidenceDraftIds.flatMap((id) => {
          const sample = samplesById.get(id);
          return sample ? normalizedEmails(sample.participants, account.email) : [];
        }),
      );
      if (contacts.size < 3) continue;
    }
    validMemories.push({ ...memory, contactEmail: null, evidenceDraftIds });
  }

  const savedCount = await saveExtractedMemories({
    userId: account.userId,
    accountId: account.id,
    source: "feedback",
    modelId: analysis.modelId,
    memories: validMemories,
  });

  const signalsByDraft = new Map<
    string,
    Array<{ type: MemoryType; statement: string }>
  >();
  for (const memory of validMemories) {
    for (const draftId of memory.evidenceDraftIds) {
      const signals = signalsByDraft.get(draftId) ?? [];
      signals.push({ type: memory.type, statement: memory.statement });
      signalsByDraft.set(draftId, signals);
    }
  }
  await markDraftFeedbackAnalyzed({
    draftIds: samples.map((sample) => sample.id),
    signalsByDraft,
  });

  return {
    status: "complete",
    sampleCount: samples.length,
    memoryCount: savedCount,
  };
}

async function persistWorkflowFailure(
  job: WorkflowStepJob,
  message: string,
  terminal: boolean,
  reconnectRequired: boolean,
) {
  const stepUpdated = await failWorkflowStep({ step: job, message, terminal });
  if (!stepUpdated) return;
  if (job.stepType === "gmail.sync.message" && job.runId) {
    await failMailSyncItem({
      runId: job.runId,
      providerMessageId: requiredString(job.payload.providerMessageId, "Gmail message ID"),
      attempt: job.attempts,
      message,
      terminal,
      reconnectRequired,
    });
  } else if (
    terminal &&
    job.runId &&
    ["gmail.sync.page", "gmail.sync.finalize"].includes(job.stepType)
  ) {
    await failMailSyncRun({ runId: job.runId, message, reconnectRequired });
  }
}

function workflowStepFromBullJob(bullJob: WorkflowJob): WorkflowStepJob {
  return {
    ...bullJob.data,
    stepType: bullJob.name,
    attempts:
      bullJob.data.attempts + Math.max(bullJob.attemptsMade, 1),
    maxAttempts: bullJob.data.maxAttempts,
  };
}

async function reconcileTerminalQueueFailure(bullJob: WorkflowJob, error: Error) {
  const job = workflowStepFromBullJob(bullJob);
  await persistWorkflowFailure(
    job,
    error.message || "BullMQ reported a terminal workflow failure.",
    true,
    error instanceof GmailApiError && error.status === 401,
  );
}

async function executeWorkflowJob(
  bullJob: WorkflowJob,
  handler: (job: WorkflowStepJob) => Promise<Record<string, unknown>>,
) {
  const job: WorkflowStepJob = {
    ...bullJob.data,
    stepType: bullJob.name,
    attempts: bullJob.data.attempts + bullJob.attemptsMade + 1,
    maxAttempts: bullJob.data.maxAttempts,
  };
  const started = await markWorkflowStepRunning(job.id, job.attempts);
  if (started.alreadyComplete) return started.result;
  try {
    const result = await handler(job);
    await completeWorkflowStep(job.id, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker failure";
    const terminal = job.attempts >= job.maxAttempts;
    const reconnectRequired = error instanceof GmailApiError && error.status === 401;
    await persistWorkflowFailure(job, message, terminal, reconnectRequired);
    throw error;
  }
}

function processGmailPages(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, async (job) => {
    if (job.stepType === "gmail.sync.page") return runGmailPage(job);
    if (job.stepType === "gmail.sync.finalize") return runGmailFinalize(job);
    throw new Error(`Unsupported Gmail page step: ${job.stepType}`);
  });
}

function processGmailMessage(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, runGmailMessage);
}

function processIndexingBatch(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, async (job) => {
    if (job.stepType === "embedding.backfill") return runEmbeddingBackfill(job);
    if (job.stepType === "embedding.batch.event") return runEmbeddingBatchEvent(job);
    throw new Error(`Unsupported indexing Batch step: ${job.stepType}`);
  });
}

function processIncrementalIndexing(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, runIncrementalEmbedding);
}

function processMemorySubmission(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, runMemoryExtraction);
}

function processMemoryEvent(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, async (job) => {
    if (job.stepType === "memory.batch.retry") return runMemoryBatchRetry(job);
    if (job.stepType === "memory.batch.event") return runMemoryBatchEvent(job);
    throw new Error(`Unsupported Memory Batch step: ${job.stepType}`);
  });
}

function processMemoryFeedback(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, runMemoryFeedback);
}

function startBullWorkers(runtime: BullQueueRuntime) {
  const withFailureReconciliation = {
    onTerminalFailure: reconcileTerminalQueueFailure,
  };
  runtime.createWorker("gmail-pages", processGmailPages, withFailureReconciliation);
  runtime.createWorker("gmail-messages", processGmailMessage, {
    ...withFailureReconciliation,
    concurrency: 5,
  });
  if (isAiConfigured()) {
    runtime.createWorker(
      "mail-memory-feedback",
      processMemoryFeedback,
      withFailureReconciliation,
    );
  }
  if (isEmbeddingBatchConfigured()) {
    runtime.createWorker(
      "mail-indexing-batch",
      processIndexingBatch,
      {
        ...withFailureReconciliation,
        lockDuration: batchWorkerLockDuration,
      },
    );
  }
  if (isEmbeddingConfigured()) {
    runtime.createWorker("mail-indexing-live", processIncrementalIndexing, {
      ...withFailureReconciliation,
      concurrency: 5,
    });
  }
  if (isMemoryBatchConfigured()) {
    runtime.createWorker(
      "mail-memory-submit",
      processMemorySubmission,
      {
        ...withFailureReconciliation,
        lockDuration: batchWorkerLockDuration,
      },
    );
  }
  if (isAnyMemoryBatchProviderConfigured()) {
    runtime.createWorker(
      "mail-memory-events",
      processMemoryEvent,
      withFailureReconciliation,
    );
  }
}

async function reconcileSubmittedEmbeddingBatches() {
  if (!isEmbeddingBatchConfigured()) return;

  const providerBatchIds = await listSubmittedEmbeddingBatchIds();
  let enqueued = 0;
  for (const providerBatchId of providerBatchIds) {
    try {
      const state = await getEmbeddingBatchState(providerBatchId);
      if (!terminalEmbeddingBatchStates.has(state)) continue;
      const event = await enqueueBatchEvent({
        provider: "openai",
        webhookId: `worker-startup:${providerBatchId}:${state}`,
        eventType: `batch.${state}`,
        providerBatchId,
      });
      if (event) enqueued += 1;
    } catch (error) {
      console.error("worker: submitted embedding Batch reconciliation failed", {
        providerBatchId,
        message: error instanceof Error ? error.message : "Unknown provider failure",
      });
    }
  }

  if (providerBatchIds.length > 0) {
    console.info("worker: submitted embedding Batches reconciled", {
      checked: providerBatchIds.length,
      enqueued,
    });
  }
}

async function run() {
  const runtime = new BullQueueRuntime(process.env.REDIS_URL ?? "");
  await runtime.waitUntilReady();
  await runtime.configureGlobalConcurrency();
  startBullWorkers(runtime);

  const signal = createJobSignal();
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
    signal.notify();
  };
  const stopListening = await listenForOutboxNotifications(signal.notify);
  const stopRedisReadyListener = runtime.onReady(signal.notify);

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await enqueueMissingMailSyncRuns();
    await enqueueReadyMailSyncFinalizers();
    await enqueuePostSyncWorkflowSteps();
    await reconcileSubmittedEmbeddingBatches();
    signal.notify();

    while (!stopRequested) {
      await signal.wait();
      if (stopRequested) break;
      while (!stopRequested) {
        const result = await publishOutboxBatch((jobs) => runtime.publish(jobs));
        if (result.failed || result.published === 0) break;
      }
    }
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    stopRedisReadyListener();
    await stopListening();
    await runtime.close();
  }
}

run().catch((error) => {
  console.error("worker: fatal", {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "Unknown worker failure",
  });
  process.exitCode = 1;
});
