import {
  AiConfigurationError,
  deleteGeminiMemoryBatchFiles,
  classifyThreads,
  extractFeedbackMemories,
  GeminiMemoryConfigurationError,
  isAiConfigured,
  isGeminiMemoryConfigured,
  readGeminiMemoryBatch,
  submitGeminiMemoryBatch,
  type FeedbackMemoryCandidate,
  type MemoryAnalysisThread,
  type MemoryBatchManifestEntry,
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
  enqueueAnalysisJobsForIndexedAccounts,
  enqueueMemoryBatchRetry,
  failAnalysisJob,
  failJobAndAccount,
  getDraftFeedbackSamples,
  getMemoryAnalysisThreads,
  getMemoryBatchSubmission,
  getThreadsForClassification,
  getUserAuthoredMemories,
  getWorkerAccount,
  listenForJobNotifications,
  MAIL_CLASSIFICATION_VERSION,
  MEMORY_SCHEMA_VERSION,
  markDraftFeedbackAnalyzed,
  saveExtractedMemories,
  saveThreadClassifications,
  setAccountSyncState,
  setMemorySyncStage,
  updateStoredCredential,
  upsertIndexedMessage,
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

  await upsertIndexedMessage({
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
    recent: "running",
    memory: "pending",
    history: "running",
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

type IndexedMemoryThread = Awaited<ReturnType<typeof getMemoryAnalysisThreads>>[number];

type MemorySubmissionResult = {
  providerBatchName: string;
  providerBatchId: string;
  inputFileName: string;
  modelId: string;
  requestCount: number;
  manifest: MemoryBatchManifestEntry[];
  batchAttempt: number;
  rootSubmissionJobId: string;
  replaceExisting: boolean;
};

function toMemoryAnalysisThreads(
  threads: IndexedMemoryThread[],
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

function parseSubmissionResult(value: unknown): MemorySubmissionResult {
  if (!value || typeof value !== "object") {
    throw new Error("The Gemini Memory submission result is missing.");
  }
  const result = value as Record<string, unknown>;
  if (typeof result.replaceExisting !== "boolean") {
    throw new Error("The Gemini Memory replacement state is missing.");
  }
  const manifest = parseManifest(result.manifest);
  const requestCount = requiredInteger(result.requestCount, "Gemini request count");
  if (
    manifest.length !== requestCount ||
    new Set(manifest.map((entry) => entry.key)).size !== manifest.length
  ) {
    throw new Error("The Gemini Memory batch manifest does not match its request count.");
  }
  return {
    providerBatchName: requiredString(
      result.providerBatchName,
      "Gemini batch name",
    ),
    providerBatchId: requiredString(result.providerBatchId, "Gemini batch ID"),
    inputFileName: requiredString(result.inputFileName, "Gemini input file"),
    modelId: requiredString(result.modelId, "Gemini model"),
    requestCount,
    manifest,
    batchAttempt: requiredInteger(result.batchAttempt, "Gemini batch attempt"),
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
  if (!isGeminiMemoryConfigured()) throw new GeminiMemoryConfigurationError();

  await setMemorySyncStage(account.id, "running");
  const submission = await submitGeminiMemoryBatch({
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
  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  if (!isGeminiMemoryConfigured()) throw new GeminiMemoryConfigurationError();

  const batchAttempt = requiredInteger(job.payload.batchAttempt, "Gemini batch attempt");
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
  const submission = await submitGeminiMemoryBatch({
    submissionId: job.id,
    batchAttempt,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    retryManifest: manifest,
  });
  if (!submission) throw new Error("The Gemini Memory retry produced no requests.");

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
  const submission = await getMemoryBatchSubmission(submissionJobId);
  if (!submission?.accountId || !submission.userId || submission.accountId !== job.accountId) {
    throw new Error("The Gemini Memory submission could not be matched to this account.");
  }
  const details = parseSubmissionResult(submission.result);
  const providerBatchId = requiredString(job.payload.providerBatchId, "Gemini event batch ID");
  if (
    providerBatchId !== details.providerBatchId &&
    providerBatchId !== details.providerBatchName &&
    !details.providerBatchName.endsWith(`/${providerBatchId}`)
  ) {
    throw new Error("The Gemini event does not match its Memory submission.");
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
  const batch = await readGeminiMemoryBatch({
    providerBatchName: details.providerBatchName,
    outputFileUri:
      typeof job.payload.outputFileUri === "string"
        ? job.payload.outputFileUri
        : undefined,
    expectedKeys: details.manifest.map((entry) => entry.key),
  });
  const successfulState =
    batch.state === "JOB_STATE_SUCCEEDED" ||
    batch.state === "JOB_STATE_PARTIALLY_SUCCEEDED";
  const terminalState =
    successfulState ||
    batch.state === "JOB_STATE_FAILED" ||
    batch.state === "JOB_STATE_CANCELLED" ||
    batch.state === "JOB_STATE_EXPIRED";
  if (!terminalState) {
    throw new Error(`Gemini emitted a completion event while the batch is ${batch.state}.`);
  }

  const failedKeys = new Set(
    successfulState
      ? batch.failedKeys
      : details.manifest.map((entry) => entry.key),
  );
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

  const cleanupFailures = await deleteGeminiMemoryBatchFiles({
    inputFileName: details.inputFileName,
    outputFileName: batch.outputFileName,
  });
  if (cleanupFailures.length > 0) {
    console.error("worker: Gemini Memory files could not be deleted", {
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
  if (isGeminiMemoryConfigured()) {
    jobTypes.push("memory.extract", "memory.batch.retry", "memory.batch.event");
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
      error instanceof GeminiMemoryConfigurationError
    ) {
      if (job.jobType === "memory.extract" && job.accountId) {
        await setMemorySyncStage(job.accountId, "pending");
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
    await enqueueAnalysisJobsForIndexedAccounts();
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
