import {
  AiConfigurationError,
  buildEmbeddingInput,
  classifyThreads,
  deleteEmbeddingBatchFiles,
  deleteMemoryBatchFiles,
  embedMailboxTexts,
  EmbeddingConfigurationError,
  extractFeedbackMemories,
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
  submitEmbeddingBatch,
  submitMemoryBatch,
  type EmbeddingBatchManifestEntry,
  type FeedbackMemoryCandidate,
  type MemoryAnalysisThread,
  type MemoryBatchManifestEntry,
  type BatchProvider,
  type MessageMemoryCandidate,
} from "@invook/ai";
import {
  claimNextJob,
  completeInitialSync,
  completeJob,
  decryptGoogleCredential,
  deferJobWithoutAttempt,
  DRAFT_FEEDBACK_VERSION,
  encryptGoogleCredential,
  enqueueEmbeddingBackfillContinuation,
  enqueuePostSyncJobsForAccounts,
  enqueueMemoryBatchRetry,
  failAnalysisJob,
  failJobAndAccount,
  getEmbeddingCandidates,
  getDraftFeedbackSamples,
  getMemoryAnalysisThreads,
  getBatchSubmission,
  getThreadsForClassification,
  getUserAuthoredMemories,
  getWorkerAccount,
  listenForJobNotifications,
  MAIL_INDEX_VERSION,
  MAIL_CLASSIFICATION_VERSION,
  MEMORY_SCHEMA_VERSION,
  markDraftFeedbackAnalyzed,
  markEmbeddingBatchSubmitted,
  markMessageEmbeddingsFailed,
  countIncompleteEmbeddings,
  saveMessageEmbeddings,
  saveExtractedMemories,
  saveThreadClassifications,
  setAccountSyncState,
  setIndexingSyncStage,
  setMemorySyncStage,
  updateStoredCredential,
  upsertMailboxMessage,
  type ClaimedJob,
  type GoogleCredential,
  type MemoryType,
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

const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
const workerId = `worker-${process.pid}`;
const classificationBatchSize = 12;
const feedbackBatchSize = 24;

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

async function syncMailbox(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
}) {
  let pageToken: string | undefined;

  do {
    const page = await listGmailMessages(options.accessToken, {
      maxResults: 100,
      pageToken,
    });
    const references = page.messages ?? [];

    for (let start = 0; start < references.length; start += 5) {
      const batch = references.slice(start, start + 5);
      const gmailMessages = await Promise.all(
        batch.map((reference) => getGmailMessage(options.accessToken, reference.id)),
      );
      for (const gmailMessage of gmailMessages) {
        await storeMessage({
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: parseGmailMessage(gmailMessage),
        });
      }
    }

    pageToken = page.nextPageToken;
  } while (pageToken);
}

async function runInitialSync(job: ClaimedJob) {
  if (!job.accountId) throw new Error("The Gmail sync job has no connected account.");

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account or credential was not found.");

  const storedCredential = decryptGoogleCredential(account.tokenCiphertext, encryptionKey);
  const credential = await refreshCredentialIfRequired(job.accountId, storedCredential);

  await setAccountSyncState(job.accountId, {
    mailSync: "running",
    indexing: "pending",
    memory: "pending",
  });

  await syncMailbox({
    accessToken: credential.accessToken,
    userId: account.userId,
    accountId: account.id,
    accountEmail: account.email,
  });

  const gmailProfile = await getGmailProfile(credential.accessToken);
  await completeInitialSync(job.accountId, gmailProfile.historyId);
}

async function runMailClassification(job: ClaimedJob) {
  if (!job.accountId) throw new Error("The classification job has no connected account.");
  if (!isAiConfigured()) throw new AiConfigurationError();

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");

  let classifiedCount = 0;
  while (true) {
    const candidates = await getThreadsForClassification(
      account.id,
      MAIL_CLASSIFICATION_VERSION,
      classificationBatchSize,
    );
    if (candidates.length === 0) break;

    const analysis = await classifyThreads(candidates);
    const expectedIds = new Set(candidates.map((thread) => thread.id));
    const returnedIds = new Set(analysis.threads.map((thread) => thread.threadId));
    if (
      returnedIds.size !== expectedIds.size ||
      analysis.threads.some((thread) => !expectedIds.has(thread.threadId))
    ) {
      throw new Error("The label model did not return every requested thread exactly once.");
    }

    await saveThreadClassifications({
      userId: account.userId,
      accountId: account.id,
      modelId: analysis.modelId,
      threads: analysis.threads,
    });
    classifiedCount += candidates.length;
  }

  return { classifiedCount, analysisVersion: MAIL_CLASSIFICATION_VERSION };
}

type EmbeddingSubmissionResult = {
  provider: "openai";
  providerBatchId: string;
  inputFileId: string;
  modelId: string;
  dimensions: number;
  requestCount: number;
  manifest: EmbeddingBatchManifestEntry[];
  indexVersion: number;
  hasMore: boolean;
};

function parseEmbeddingManifest(value: unknown): EmbeddingBatchManifestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("The embedding batch manifest is missing.");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("The embedding batch manifest is invalid.");
    }
    const key = "key" in entry ? entry.key : undefined;
    const messageId = "messageId" in entry ? entry.messageId : undefined;
    const contentHash = "contentHash" in entry ? entry.contentHash : undefined;
    if (
      typeof key !== "string" ||
      typeof messageId !== "string" ||
      typeof contentHash !== "string" ||
      key !== messageId
    ) {
      throw new Error("The embedding batch manifest is invalid.");
    }
    return { key, messageId, contentHash };
  });
}

function parseEmbeddingSubmissionResult(value: unknown): EmbeddingSubmissionResult {
  if (!value || typeof value !== "object") {
    throw new Error("The embedding batch submission result is missing.");
  }
  const result = value as Record<string, unknown>;
  const manifest = parseEmbeddingManifest(result.manifest);
  const requestCount = requiredInteger(
    result.requestCount,
    "Embedding batch request count",
  );
  if (
    manifest.length !== requestCount ||
    new Set(manifest.map((entry) => entry.key)).size !== manifest.length
  ) {
    throw new Error("The embedding batch manifest does not match its request count.");
  }
  if (result.provider !== "openai" || typeof result.hasMore !== "boolean") {
    throw new Error("The embedding batch provider details are invalid.");
  }
  return {
    provider: "openai",
    providerBatchId: requiredString(result.providerBatchId, "provider batch ID"),
    inputFileId: requiredString(result.inputFileId, "provider input file"),
    modelId: requiredString(result.modelId, "embedding model"),
    dimensions: requiredInteger(result.dimensions, "embedding dimensions"),
    requestCount,
    manifest,
    indexVersion: requiredInteger(result.indexVersion, "embedding index version"),
    hasMore: result.hasMore,
  };
}

async function runEmbeddingBackfill(job: ClaimedJob) {
  if (!job.accountId || !job.userId) {
    throw new Error("The embedding backfill has no connected account.");
  }
  const config = getEmbeddingConfiguration();
  await setIndexingSyncStage(job.accountId, "running");
  const candidates = await getEmbeddingCandidates({
    accountId: job.accountId,
    modelId: config.modelId,
    indexVersion: MAIL_INDEX_VERSION,
    limit: 50_000,
    includeFailed: job.payload.includeFailed !== false,
  });
  if (candidates.length === 0) {
    const incompleteCount = await countIncompleteEmbeddings({
      accountId: job.accountId,
      modelId: config.modelId,
      indexVersion: MAIL_INDEX_VERSION,
    });
    await setIndexingSyncStage(
      job.accountId,
      incompleteCount === 0 ? "complete" : "failed",
    );
    return { status: incompleteCount === 0 ? "complete" : "failed", incompleteCount };
  }

  const submission = await submitEmbeddingBatch({
    submissionId: job.id,
    messages: candidates,
  });
  if (!submission) {
    await setIndexingSyncStage(job.accountId, "complete");
    return { status: "complete", requestCount: 0 };
  }
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.messageId, candidate]),
  );
  await markEmbeddingBatchSubmitted({
    accountId: job.accountId,
    modelId: submission.modelId,
    dimensions: submission.dimensions,
    indexVersion: MAIL_INDEX_VERSION,
    providerBatchId: submission.providerBatchId,
    messages: submission.manifest.map((entry) => {
      const candidate = candidatesById.get(entry.messageId);
      if (!candidate) throw new Error("An embedding batch candidate is missing.");
      return {
        messageId: entry.messageId,
        userId: candidate.userId,
        contentHash: entry.contentHash,
      };
    }),
  });
  return {
    status: "submitted",
    batchPurpose: "embedding",
    ...submission,
    indexVersion: MAIL_INDEX_VERSION,
    hasMore: submission.requestCount < candidates.length,
  };
}

async function runIncrementalEmbedding(job: ClaimedJob) {
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

async function runEmbeddingBatchEvent(job: ClaimedJob) {
  if (!job.accountId) throw new Error("The embedding batch event has no account.");
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "embedding submission job ID",
  );
  const submission = await getBatchSubmission(submissionJobId);
  if (
    !submission?.accountId ||
    !submission.userId ||
    submission.accountId !== job.accountId ||
    submission.jobType !== "embedding.backfill"
  ) {
    throw new Error("The embedding batch submission could not be matched.");
  }
  const details = parseEmbeddingSubmissionResult(submission.result);
  if (
    job.payload.provider !== details.provider ||
    job.payload.providerBatchId !== details.providerBatchId
  ) {
    throw new Error("The provider event does not match its embedding submission.");
  }
  const batch = await readEmbeddingBatch({
    providerBatchId: details.providerBatchId,
    expectedKeys: details.manifest.map((entry) => entry.key),
    expectedDimensions: details.dimensions,
  });
  const terminalState = ["completed", "failed", "cancelled", "expired"].includes(
    batch.state,
  );
  if (!terminalState) {
    throw new Error(
      `OpenAI emitted a terminal event while the embedding batch is ${batch.state}.`,
    );
  }

  const manifestByKey = new Map(details.manifest.map((entry) => [entry.key, entry]));
  const savedCount = await saveMessageEmbeddings({
    accountId: submission.accountId,
    modelId: details.modelId,
    dimensions: details.dimensions,
    indexVersion: details.indexVersion,
    values: [...batch.embeddingsByKey].flatMap(([key, embedding]) => {
      const entry = manifestByKey.get(key);
      return entry
        ? [{
            messageId: entry.messageId,
            userId: submission.userId!,
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
      modelId: details.modelId,
      indexVersion: details.indexVersion,
      values: failedEntries,
      error: batch.providerError ?? `OpenAI embedding batch ended as ${batch.state}.`,
    });
  }

  let continuationJobId: string | null = null;
  if (details.hasMore) {
    continuationJobId = await enqueueEmbeddingBackfillContinuation({
      userId: submission.userId,
      accountId: submission.accountId,
      modelId: details.modelId,
      indexVersion: details.indexVersion,
      predecessorBatchId: details.providerBatchId,
    });
  }
  const incompleteCount = await countIncompleteEmbeddings({
    accountId: submission.accountId,
    modelId: details.modelId,
    indexVersion: details.indexVersion,
  });
  await setIndexingSyncStage(
    submission.accountId,
    continuationJobId
      ? "running"
      : failedEntries.length > 0
        ? "failed"
        : incompleteCount > 0
          ? "running"
          : "complete",
  );

  const cleanupFailures = await deleteEmbeddingBatchFiles({
    inputFileId: details.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  if (cleanupFailures.length > 0) {
    console.error("worker: embedding batch files could not be deleted", {
      submissionJobId: submission.id,
      fileCount: cleanupFailures.length,
    });
  }
  return {
    status:
      failedEntries.length > 0
        ? "failed"
        : continuationJobId || incompleteCount > 0
          ? "continuing"
          : "complete",
    providerState: batch.state,
    providerError: batch.providerError,
    savedCount,
    failedRequestCount: failedEntries.length,
    incompleteCount,
    continuationJobId,
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

async function runMemoryExtraction(job: ClaimedJob) {
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

async function runMemoryBatchRetry(job: ClaimedJob) {
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

async function runMemoryBatchEvent(job: ClaimedJob) {
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

async function runMemoryFeedback(job: ClaimedJob) {
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

async function markJobFailed(job: ClaimedJob, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown worker failure";
  if (job.jobType !== "gmail.initial_sync") {
    await failAnalysisJob({
      job,
      message,
    });
    return;
  }

  await failJobAndAccount({
    job,
    message,
    reconnectRequired: error instanceof GmailApiError && error.status === 401,
  });
}

async function processNextJob() {
  const jobTypes = ["gmail.initial_sync"];
  if (isAiConfigured()) jobTypes.push("mail.classify", "memory.feedback");
  if (isEmbeddingConfigured()) jobTypes.push("embedding.incremental");
  if (isEmbeddingBatchConfigured()) {
    jobTypes.push("embedding.backfill", "embedding.batch.event");
  }
  if (isMemoryBatchConfigured()) jobTypes.push("memory.extract");
  if (isAnyMemoryBatchProviderConfigured()) {
    jobTypes.push("memory.batch.retry", "memory.batch.event");
  }
  const job = await claimNextJob(workerId, jobTypes);
  if (!job) return false;

  try {
    let result: Record<string, unknown> = {};
    switch (job.jobType) {
      case "gmail.initial_sync":
        await runInitialSync(job);
        break;
      case "mail.classify":
        result = await runMailClassification(job);
        break;
      case "embedding.backfill":
        result = await runEmbeddingBackfill(job);
        break;
      case "embedding.incremental":
        result = await runIncrementalEmbedding(job);
        break;
      case "embedding.batch.event":
        result = await runEmbeddingBatchEvent(job);
        break;
      case "memory.extract":
        result = await runMemoryExtraction(job);
        break;
      case "memory.batch.retry":
        result = await runMemoryBatchRetry(job);
        break;
      case "memory.batch.event":
        result = await runMemoryBatchEvent(job);
        break;
      case "memory.feedback":
        result = await runMemoryFeedback(job);
        break;
      default:
        throw new Error(`Unsupported job type: ${job.jobType}`);
    }
    await completeJob(job.id, result);
  } catch (error) {
    if (
      error instanceof AiConfigurationError ||
      error instanceof EmbeddingConfigurationError ||
      error instanceof MemoryBatchConfigurationError
    ) {
      if (job.jobType === "memory.extract" && job.accountId) {
        await setMemorySyncStage(job.accountId, "pending");
      }
      if (job.jobType.startsWith("embedding.") && job.accountId) {
        await setIndexingSyncStage(job.accountId, "pending");
      }
      await deferJobWithoutAttempt({
        jobId: job.id,
        message: error.message,
      });
      return false;
    }
    await markJobFailed(job, error);
    throw error;
  }

  return true;
}

async function run() {
  const signal = createJobSignal();
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
    signal.notify();
  };
  const stopListening = await listenForJobNotifications(signal.notify);

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await enqueuePostSyncJobsForAccounts(
      isEmbeddingConfigured()
        ? { ...getEmbeddingConfiguration(), indexVersion: MAIL_INDEX_VERSION }
        : null,
    );
    signal.notify();

    while (!stopRequested) {
      await signal.wait();
      if (stopRequested) break;
      while (await processNextJob()) {
        // Drain every currently eligible job before waiting for another notification.
      }
    }
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await stopListening();
  }
}

run().catch((error) => {
  console.error("worker: fatal", {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "Unknown worker failure",
  });
  process.exitCode = 1;
});
