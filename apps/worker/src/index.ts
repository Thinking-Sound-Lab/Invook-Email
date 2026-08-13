import { createHash } from "node:crypto";

import {
  AiConfigurationError,
  deleteBatchFiles,
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
  readLabelBatch,
  submitLabelBatch,
  readEmbeddingBatch,
  readMemoryBatch,
  prepareEmbeddingBatch,
  submitMemoryBatch,
  uploadEmbeddingBatchInput,
  type FeedbackMemoryCandidate,
  type LabelAnalysisThread,
  type LabelBatchManifestEntry,
  type MemoryAnalysisThread,
  type MemoryBatchManifestEntry,
  type BatchProvider,
  type MessageMemoryCandidate,
} from "@invook/ai";
import {
  clearPendingMemoryEvidence,
  applyGmailHistoryBatch,
  beginGmailReplicaAudit,
  completeGmailReplicaAudit,
  failGmailReplicaAudit,
  deleteIndexedMessage,
  completeMailSyncItem,
  completeMailSyncRun,
  completeEmbeddingBatchSubmission,
  completeWorkflowStep,
  countFailedEmbeddings,
  decryptGoogleCredential,
  DRAFT_FEEDBACK_VERSION,
  encryptGoogleCredential,
  enqueueDailyGmailWatchRenewal,
  ensureDailyGmailWatchRenewals,
  enqueuePendingAnalysisWorkflowSteps,
  enqueueLabelBackfillContinuation,
  enqueueLabelBatchRetry,
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
  getIndexedMessageIds,
  getLabelBatchSubmission,
  getLabelForAnalysis,
  getMemoryAnalysisThreads,
  getThreadsForLabelBackfill,
  getThreadsForLabelRetry,
  getUserAuthoredMemories,
  getWorkerAccount,
  getGmailReplicaContext,
  getGmailReplicaInventory,
  getGmailWatchContext,
  GmailLabelCatalogMismatchError,
  isActiveMailSyncRun,
  saveLabelBatchResults,
  setLabelAnalysisState,
  getBatchSubmission,
  hasCompletedMailSyncPage,
  listenForOutboxNotifications,
  MAIL_INDEX_VERSION,
  listGmailObjectKeysForAccount,
  markGmailAccountCleanupRunning,
  listSubmittedEmbeddingBatchIds,
  markGmailReplicaReady,
  markMailSyncItemRunning,
  markWorkflowStepRunning,
  MEMORY_SCHEMA_VERSION,
  markDraftFeedbackAnalyzed,
  markEmbeddingBatchSubmitted,
  markMessageEmbeddingsFailed,
  countIncompleteEmbeddings,
  saveMessageEmbeddings,
  saveExtractedMemories,
  saveGmailWatchState,
  setGmailReplicaState,
  setIndexingSyncStage,
  setMemorySyncStage,
  toPostgresTextProjection,
  publishOutboxBatch,
  replaceGmailDraftResources,
  replaceGmailLabelCatalog,
  prepareEmbeddingBatchSubmission,
  recordEmbeddingBatchInputFile,
  recordEmbeddingProviderBatch,
  recordMailSyncPage,
  refreshPreparingEmbeddingBatchSubmission,
  startMailSyncRun,
  updateStoredCredential,
  upsertMailboxMessage,
  withGmailAccountControlLock,
  type GoogleCredential,
  type IndexedMessage,
  type MemoryType,
  type WorkflowStepJob,
} from "@invook/database";
import {
  extractEmailAddress,
  gmailHistoryChanges,
  getGmailDraft,
  getGmailMessage,
  getGmailMessageState,
  getGmailProfile,
  GmailApiError,
  isMemoryEligible,
  listGmailDrafts,
  listGmailHistory,
  listGmailLabels,
  listGmailMessages,
  parseGmailMessage,
  refreshGoogleAccessToken,
  startGmailWatch,
  stopGmailWatch,
  type ParsedGmailMessage,
} from "@invook/gmail";
import { createObjectStorage } from "@invook/object-storage";

import {
  BullQueueRuntime,
  gmailControlConcurrency,
  type WorkflowJob,
} from "./queue";
import {
  findGmailLabelMembershipMismatches,
  type GmailLabelMembershipSnapshot,
} from "./gmail-label-membership";
import {
  applyGmailHistoryWithExpiredCursorRepair,
  shouldRepairNonReadyGmailReplica,
} from "./gmail-history-recovery";
import { runDailyGmailWatchRenewal } from "./gmail-watch-renewal";

const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
const feedbackBatchSize = 24;
const embeddingBatchRequestLimit = 2_000;
const embeddingBatchAttemptLimit = 3;
const batchWorkerLockDuration = 5 * 60 * 1_000;
const credentialRenewalWindowMs = 5 * 60 * 1_000;
const objectStorage = createObjectStorage();
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
  const expiresSoon =
    Date.parse(credential.expiresAt) <= Date.now() + credentialRenewalWindowMs;
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

async function prepareMessage(options: {
  userId: string;
  accountId: string;
  accountEmail: string;
  message: ParsedGmailMessage;
  ingestionMode: "initial" | "incremental";
}): Promise<IndexedMessage> {
  const { userId, accountId, accountEmail, message, ingestionMode } = options;
  const direction =
    message.labelIds.includes("SENT") ||
    extractEmailAddress(message.from) === accountEmail.toLowerCase()
      ? "outgoing"
      : "incoming";
  const internalDateValue = options.message.internalDate
    ? Number(options.message.internalDate)
    : Number.NaN;
  const internalDate = Number.isFinite(internalDateValue)
    ? new Date(internalDateValue)
    : options.message.sentAt
      ? new Date(options.message.sentAt)
      : null;
  const sentAt = options.message.sentAt
    ? new Date(options.message.sentAt)
    : internalDate;
  if (
    !internalDate ||
    !sentAt ||
    !Number.isFinite(internalDate.getTime()) ||
    !Number.isFinite(sentAt.getTime())
  ) {
    throw new Error(
      `Gmail message ${message.providerMessageId} has no usable internal or sent date.`,
    );
  }

  const rawObject = await objectStorage.putObject({
    key: `${accountId}/messages/${message.providerMessageId}/raw.eml`,
    body: message.raw,
    contentType: "message/rfc822",
  });
  const attachments = await Promise.all(
    message.attachments.map(async (attachment) => {
      const attachmentObject = await objectStorage.putObject({
        key: `${accountId}/messages/${message.providerMessageId}/attachments/${attachment.index}-${attachment.checksumSha256}`,
        body: attachment.content,
        contentType: attachment.mimeType,
      });
      return {
        providerAttachmentId: null,
        mimePartPath: attachment.mimePartPath
          ? toPostgresTextProjection(attachment.mimePartPath)
          : null,
        filename: toPostgresTextProjection(attachment.filename ?? ""),
        mimeType: attachment.mimeType
          ? toPostgresTextProjection(attachment.mimeType)
          : null,
        contentId: attachment.contentId
          ? toPostgresTextProjection(attachment.contentId)
          : null,
        contentDisposition: attachment.contentDisposition
          ? toPostgresTextProjection(attachment.contentDisposition)
          : null,
        size: attachment.size,
        objectKey: attachmentObject.key,
        checksumSha256: attachmentObject.checksumSha256,
        contentLength: attachmentObject.contentLength,
        etag: attachmentObject.etag,
      };
    }),
  );

  return {
    userId,
    accountId,
    providerThreadId: message.providerThreadId,
    providerMessageId: message.providerMessageId,
    subject: toPostgresTextProjection(message.subject),
    snippet: toPostgresTextProjection(message.snippet),
    participants: [message.from, ...message.to, ...message.cc]
      .filter(Boolean)
      .map(toPostgresTextProjection),
    gmailLabelIds: message.labelIds,
    providerHistoryId: message.historyId,
    internalDate,
    sizeEstimate: message.sizeEstimate,
    headerLines: message.headers.map((header) => ({
      key: toPostgresTextProjection(header.name),
      line: toPostgresTextProjection(header.raw),
    })),
    sentAt,
    direction,
    sender: {
      raw: toPostgresTextProjection(message.from),
      email: toPostgresTextProjection(extractEmailAddress(message.from)),
    },
    recipients: [...message.to, ...message.cc].map(toPostgresTextProjection),
    bodyText: toPostgresTextProjection(message.bodyText ?? ""),
    bodyHtml: message.bodyHtml
      ? toPostgresTextProjection(message.bodyHtml)
      : null,
    rawObject,
    isMemoryEligible: direction === "outgoing" && isMemoryEligible(message),
    ingestionMode,
    memoryContactEmails: normalizedEmails(
      [message.from, ...message.to, ...message.cc],
      accountEmail,
    ).map(toPostgresTextProjection),
    attachments,
  };
}

async function withRefreshedGmailLabelCatalog<T>(
  options: { accessToken: string; userId: string; accountId: string },
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof GmailLabelCatalogMismatchError)) throw error;
    await syncGmailLabelCatalog(options);
    return operation();
  }
}

async function storeMessage(
  options: Parameters<typeof prepareMessage>[0] & { accessToken: string },
) {
  const { accessToken, ...messageOptions } = options;
  const message = await prepareMessage(messageOptions);
  return withRefreshedGmailLabelCatalog(
    {
      accessToken,
      userId: messageOptions.userId,
      accountId: messageOptions.accountId,
    },
    () => upsertMailboxMessage(message),
  );
}

async function syncGmailLabelCatalog(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  notify?: boolean;
}) {
  const labels = await listGmailLabels(options.accessToken);
  for (const label of labels) {
    if (label.type !== "system" && label.type !== "user") {
      throw new Error(`Gmail label ${label.id} did not include a supported type.`);
    }
  }
  await replaceGmailLabelCatalog({
    userId: options.userId,
    accountId: options.accountId,
    notify: options.notify,
    labels: labels.map((label) => ({
      providerLabelId: label.id,
      name: label.name,
      type: label.type as "system" | "user",
      messageListVisibility: label.messageListVisibility ?? null,
      labelListVisibility: label.labelListVisibility ?? null,
      color: label.color ?? null,
      providerMetadata: {
        messagesTotal: label.messagesTotal ?? null,
        messagesUnread: label.messagesUnread ?? null,
        threadsTotal: label.threadsTotal ?? null,
        threadsUnread: label.threadsUnread ?? null,
      },
    })),
  });
  return labels;
}

async function syncGmailDraftResources(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  ingestionMode: "initial" | "incremental";
  notify?: boolean;
}) {
  let pageToken: string | undefined;
  const drafts: Array<{
    providerDraftId: string;
    providerMessageId: string;
    providerThreadId: string;
    providerHistoryId: string | null;
    providerMetadata: Record<string, unknown>;
  }> = [];
  do {
    const page = await listGmailDrafts(options.accessToken, {
      maxResults: 100,
      pageToken,
    });
    for (const reference of page.drafts ?? []) {
      const draft = await getGmailDraft(options.accessToken, reference.id);
      const parsed = await parseGmailMessage(draft.message);
      await storeMessage({
        accessToken: options.accessToken,
        userId: options.userId,
        accountId: options.accountId,
        accountEmail: options.accountEmail,
        message: parsed,
        ingestionMode: options.ingestionMode,
      });
      drafts.push({
        providerDraftId: draft.id,
        providerMessageId: draft.message.id,
        providerThreadId: draft.message.threadId,
        providerHistoryId: draft.message.historyId ?? null,
        providerMetadata: {
          labelIds: draft.message.labelIds ?? [],
          snippet: draft.message.snippet ?? null,
          internalDate: draft.message.internalDate ?? null,
          sizeEstimate: draft.message.sizeEstimate ?? null,
        },
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  await replaceGmailDraftResources({
    userId: options.userId,
    accountId: options.accountId,
    drafts,
    notify: options.notify,
  });
  return drafts;
}

async function syncMailbox(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  ingestionMode: "initial" | "incremental";
}) {
  let pageToken: string | undefined;
  const changedThreadIds = new Set<string>();
  const providerMessageIds = new Set<string>();

  do {
    const page = await listGmailMessages(options.accessToken, {
      pageToken,
    });
    const references = page.messages ?? [];

    for (let start = 0; start < references.length; start += 5) {
      const batch = references.slice(start, start + 5);
      const gmailMessages = await Promise.all(
        batch.map(async (reference) => {
          try {
            return await getGmailMessage(options.accessToken, reference.id);
          } catch (error) {
            if (error instanceof GmailApiError && error.status === 404) return null;
            throw error;
          }
        }),
      );
      for (const gmailMessage of gmailMessages) {
        if (!gmailMessage) continue;
        providerMessageIds.add(gmailMessage.id);
        const stored = await storeMessage({
          accessToken: options.accessToken,
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: await parseGmailMessage(gmailMessage),
          ingestionMode: options.ingestionMode,
        });
        if (stored.changed) changedThreadIds.add(stored.threadId);
      }
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  const indexedMessageIds = await getIndexedMessageIds(options.accountId);
  for (const messageId of indexedMessageIds) {
    if (providerMessageIds.has(messageId)) continue;
    const deleted = await deleteIndexedMessage({
      accountId: options.accountId,
      providerMessageId: messageId,
    });
    if (deleted.changed && deleted.threadId) {
      changedThreadIds.add(deleted.threadId);
    }
  }

  return changedThreadIds;
}

async function listProviderMessageIds(accessToken: string): Promise<string[]> {
  let pageToken: string | undefined;
  const messageIds: string[] = [];
  do {
    const page = await listGmailMessages(accessToken, {
      pageToken,
    });
    messageIds.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return messageIds;
}

async function getProviderMessageLabelMemberships(
  accessToken: string,
  providerMessageIds: string[],
): Promise<{
  memberships: GmailLabelMembershipSnapshot[];
  unavailableMessageIds: string[];
}> {
  const memberships: GmailLabelMembershipSnapshot[] = [];
  const unavailableMessageIds: string[] = [];
  for (let start = 0; start < providerMessageIds.length; start += 5) {
    const batch = providerMessageIds.slice(start, start + 5);
    const states = await Promise.all(
      batch.map(async (providerMessageId) => {
        try {
          return await getGmailMessageState(accessToken, providerMessageId);
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) return null;
          throw error;
        }
      }),
    );
    states.forEach((state, index) => {
      if (!state) {
        const providerMessageId = batch[index];
        if (providerMessageId) unavailableMessageIds.push(providerMessageId);
        return;
      }
      memberships.push({
        providerMessageId: state.id,
        providerLabelIds: state.labelIds ?? [],
      });
    });
  }
  return { memberships, unavailableMessageIds };
}

async function findObjectFailures(
  objects: Array<{
    providerMessageId: string;
    key: string | null;
    checksumSha256: string | null;
    contentLength: number | null;
  }>,
) {
  const failures: Array<{
    providerMessageId: string;
    key: string | null;
    reason: string;
  }> = [];
  for (let start = 0; start < objects.length; start += 10) {
    const batch = objects.slice(start, start + 10);
    const results = await Promise.all(
      batch.map(async (object) => {
        if (!object.key) {
          return {
            providerMessageId: object.providerMessageId,
            key: null,
            reason: "missing_object_key",
          };
        }
        try {
          const content = await objectStorage.getObject(object.key);
          if (
            object.contentLength !== null &&
            content.byteLength !== object.contentLength
          ) {
            return {
              providerMessageId: object.providerMessageId,
              key: object.key,
              reason: "content_length_mismatch",
            };
          }
          if (
            object.checksumSha256 !== null &&
            createHash("sha256").update(content).digest("hex") !==
              object.checksumSha256
          ) {
            return {
              providerMessageId: object.providerMessageId,
              key: object.key,
              reason: "checksum_mismatch",
            };
          }
          return null;
        } catch {
          return {
            providerMessageId: object.providerMessageId,
            key: object.key,
            reason: "object_unavailable",
          };
        }
      }),
    );
    failures.push(
      ...results.filter(
        (
          result,
        ): result is {
          providerMessageId: string;
          key: string | null;
          reason: string;
        } => result !== null,
      ),
    );
  }
  return failures;
}

async function applyHistoryRange(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  startHistoryId: string;
  expectedCursor: string;
  pushEventId?: string | null;
  stateAfterApply?: "ready" | "replaying" | "repairing";
  markStoredPushEventsProcessed?: boolean;
  ingestionMode: "initial" | "incremental";
}) {
  let pageToken: string | undefined;
  let historyId = options.startHistoryId;
  const messageActions = new Map<
    string,
    { action: "upsert" | "delete"; providerHistoryId: string | null }
  >();

  do {
    const page = await listGmailHistory(options.accessToken, {
      startHistoryId: options.startHistoryId,
      maxResults: 500,
      pageToken,
    });
    for (const history of page.history ?? []) {
      for (const change of gmailHistoryChanges(history)) {
        messageActions.set(change.messageId, {
          action: change.action,
          providerHistoryId: history.id ?? null,
        });
      }
    }
    if (page.historyId) historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const deletedMessageIds = Array.from(messageActions)
    .filter(([, change]) => change.action === "delete")
    .map(([providerMessageId, change]) => ({
      providerMessageId,
      providerHistoryId: change.providerHistoryId,
    }));
  const ids = Array.from(messageActions)
    .filter(([, change]) => change.action === "upsert")
    .map(([messageId]) => messageId);
  const messages: IndexedMessage[] = [];
  for (let start = 0; start < ids.length; start += 5) {
    const batch = ids.slice(start, start + 5);
    const gmailMessages = await Promise.all(
      batch.map(async (messageId) => {
        try {
          return {
            messageId,
            message: await getGmailMessage(options.accessToken, messageId),
          };
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            return { messageId, message: null };
          }
          throw error;
        }
      }),
    );
    for (const gmailMessage of gmailMessages) {
      if (!gmailMessage.message) {
        deletedMessageIds.push({
          providerMessageId: gmailMessage.messageId,
          providerHistoryId:
            messageActions.get(gmailMessage.messageId)?.providerHistoryId ?? null,
        });
        continue;
      }
      messages.push(
        await prepareMessage({
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: await parseGmailMessage(gmailMessage.message),
          ingestionMode: options.ingestionMode,
        }),
      );
    }
  }

  const applied = await withRefreshedGmailLabelCatalog(
    {
      accessToken: options.accessToken,
      userId: options.userId,
      accountId: options.accountId,
    },
    () =>
      applyGmailHistoryBatch({
        userId: options.userId,
        accountId: options.accountId,
        expectedCursor: options.expectedCursor,
        nextCursor: historyId,
        messages,
        deletedMessageIds,
        pushEventId: options.pushEventId,
        stateAfterApply: options.stateAfterApply,
        markStoredPushEventsProcessed: options.markStoredPushEventsProcessed,
      }),
  );
  return { ...applied, historyId };
}

async function getMailSyncContext(accountId: string) {
  const account = await getWorkerAccount(accountId);
  if (!account) {
    throw new Error("The connected Gmail account or credential was not found.");
  }
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
  if (
    rawPageToken !== null &&
    rawPageToken !== undefined &&
    typeof rawPageToken !== "string"
  ) {
    throw new Error("The Gmail page token is invalid.");
  }
  if (await hasCompletedMailSyncPage(runId, pageNumber)) {
    return { status: "current", runId, pageNumber };
  }

  const active = await startMailSyncRun(runId, job.accountId);
  if (!active) return { status: "inactive", runId, pageNumber };
  const { account, credential } = await getMailSyncContext(job.accountId);
  if (pageNumber === 1) {
    await ensureGmailWatch(account.id, credential.accessToken);
    await setGmailReplicaState({ accountId: account.id, state: "snapshotting" });
    await syncGmailLabelCatalog({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
    });
  }
  const page = await listGmailMessages(credential.accessToken, {
    pageToken: rawPageToken ?? undefined,
  });
  const providerMessageIds = (page.messages ?? []).map((message) => message.id);
  const recorded = await recordMailSyncPage({
    runId,
    userId: account.userId,
    accountId: account.id,
    pageNumber,
    pageToken: rawPageToken ?? null,
    nextPageToken: page.nextPageToken ?? null,
    providerMessageIds,
  });
  if (!recorded) return { status: "inactive", runId, pageNumber };
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
    job.accountId,
    providerMessageId,
    job.attempts,
  );
  if (!shouldProcess) {
    return { status: "current", runId, providerMessageId };
  }
  const { account, credential } = await getMailSyncContext(job.accountId);
  let gmailMessage;
  try {
    gmailMessage = await getGmailMessage(credential.accessToken, providerMessageId);
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    const completed = await completeMailSyncItem(runId, providerMessageId);
    return {
      status: completed ? "gone" : "inactive",
      runId,
      providerMessageId,
    };
  }
  await storeMessage({
    accessToken: credential.accessToken,
    userId: account.userId,
    accountId: account.id,
    accountEmail: account.email,
    ingestionMode: "initial",
    message: await parseGmailMessage(gmailMessage),
  });
  const completed = await completeMailSyncItem(runId, providerMessageId);
  return {
    status: completed ? "complete" : "inactive",
    runId,
    providerMessageId,
  };
}

function gmailPubSubTopic(): string {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC?.trim();
  if (!topicName) {
    throw new Error("GMAIL_PUBSUB_TOPIC is required for Gmail watch state.");
  }
  return topicName;
}

async function renewGmailWatch(accountId: string, accessToken: string) {
  const topicName = gmailPubSubTopic();
  const watch = await startGmailWatch(accessToken, { topicName });
  const expiration = Number(watch.expiration);
  if (!Number.isFinite(expiration)) {
    throw new Error("Gmail returned an invalid watch expiration.");
  }
  const renewedAt = new Date();
  const expirationAt = new Date(expiration);
  await saveGmailWatchState({
    accountId,
    watch: {
      topicName,
      historyId: watch.historyId,
      expirationAt,
    },
    renewedAt,
  });
  return { historyId: watch.historyId, expirationAt, renewedAt };
}

async function ensureGmailWatch(accountId: string, accessToken: string) {
  const watch = await getGmailWatchContext(accountId);
  if (watch?.status === "active" && watch.expirationAt.getTime() > Date.now()) {
    return;
  }
  await renewGmailWatch(accountId, accessToken);
}

async function runReplicaAudit(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  trigger: "initial" | "history_expired" | "watch_renewal" | "manual";
}) {
  const ingestionMode =
    options.trigger === "initial" || options.trigger === "history_expired"
      ? "initial"
      : "incremental";
  await setGmailReplicaState({ accountId: options.accountId, state: "auditing" });
  const auditId = await beginGmailReplicaAudit({
    userId: options.userId,
    accountId: options.accountId,
    trigger: options.trigger,
  });
  try {
    await syncGmailLabelCatalog({
      accessToken: options.accessToken,
      userId: options.userId,
      accountId: options.accountId,
    });
    await syncGmailDraftResources({
      accessToken: options.accessToken,
      userId: options.userId,
      accountId: options.accountId,
      accountEmail: options.accountEmail,
      ingestionMode,
    });
    const providerMessageIds = await listProviderMessageIds(options.accessToken);
    const storedMessageIds = await getIndexedMessageIds(options.accountId);
    const providerIds = new Set(providerMessageIds);
    const storedIds = new Set(storedMessageIds);
    const missingMessageIds = providerMessageIds.filter((id) => !storedIds.has(id));
    const extraMessageIds = storedMessageIds.filter((id) => !providerIds.has(id));

    for (let start = 0; start < missingMessageIds.length; start += 5) {
      const batch = missingMessageIds.slice(start, start + 5);
      const gmailMessages = await Promise.all(
        batch.map(async (messageId) => {
          try {
            return await getGmailMessage(options.accessToken, messageId);
          } catch (error) {
            if (error instanceof GmailApiError && error.status === 404) return null;
            throw error;
          }
        }),
      );
      for (const gmailMessage of gmailMessages) {
        if (!gmailMessage) continue;
        await storeMessage({
          accessToken: options.accessToken,
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: await parseGmailMessage(gmailMessage),
          ingestionMode,
        });
      }
    }
    for (const providerMessageId of extraMessageIds) {
      await deleteIndexedMessage({ accountId: options.accountId, providerMessageId });
    }

    let providerLabels = await syncGmailLabelCatalog({
      accessToken: options.accessToken,
      userId: options.userId,
      accountId: options.accountId,
    });
    const providerDrafts = await syncGmailDraftResources({
      accessToken: options.accessToken,
      userId: options.userId,
      accountId: options.accountId,
      accountEmail: options.accountEmail,
      ingestionMode,
    });
    const repairedProviderMessageIds = await listProviderMessageIds(
      options.accessToken,
    );
    let inventory = await getGmailReplicaInventory(options.accountId);
    let objectFailures = await findObjectFailures(inventory.objects);
    const repairableObjectMessageIds = Array.from(
      new Set(
        objectFailures
          .map((failure) => failure.providerMessageId)
          .filter((id) => repairedProviderMessageIds.includes(id)),
      ),
    );
    for (let start = 0; start < repairableObjectMessageIds.length; start += 5) {
      const batch = repairableObjectMessageIds.slice(start, start + 5);
      const gmailMessages = await Promise.all(
        batch.map((messageId) => getGmailMessage(options.accessToken, messageId)),
      );
      for (const gmailMessage of gmailMessages) {
        await storeMessage({
          accessToken: options.accessToken,
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: await parseGmailMessage(gmailMessage),
          ingestionMode,
        });
      }
    }
    if (repairableObjectMessageIds.length > 0) {
      inventory = await getGmailReplicaInventory(options.accountId);
      objectFailures = await findObjectFailures(inventory.objects);
    }

    const providerMembershipSnapshot = await getProviderMessageLabelMemberships(
      options.accessToken,
      repairedProviderMessageIds,
    );
    const membershipMismatches = findGmailLabelMembershipMismatches(
      providerMembershipSnapshot.memberships,
      inventory.messageLabelMemberships,
    );
    const unavailableMembershipMessageIds = new Set(
      providerMembershipSnapshot.unavailableMessageIds,
    );
    for (let start = 0; start < membershipMismatches.length; start += 5) {
      const batch = membershipMismatches.slice(start, start + 5);
      const gmailMessages = await Promise.all(
        batch.map(async (mismatch) => {
          try {
            return await getGmailMessage(
              options.accessToken,
              mismatch.providerMessageId,
            );
          } catch (error) {
            if (error instanceof GmailApiError && error.status === 404) return null;
            throw error;
          }
        }),
      );
      for (const [index, gmailMessage] of gmailMessages.entries()) {
        if (!gmailMessage) {
          const mismatch = batch[index];
          if (mismatch) {
            unavailableMembershipMessageIds.add(mismatch.providerMessageId);
          }
          continue;
        }
        await storeMessage({
          accessToken: options.accessToken,
          userId: options.userId,
          accountId: options.accountId,
          accountEmail: options.accountEmail,
          message: await parseGmailMessage(gmailMessage),
          ingestionMode,
        });
      }
    }
    if (membershipMismatches.length > 0) {
      providerLabels = await syncGmailLabelCatalog({
        accessToken: options.accessToken,
        userId: options.userId,
        accountId: options.accountId,
      });
      inventory = await getGmailReplicaInventory(options.accountId);
    }
    const remainingMembershipMismatches = findGmailLabelMembershipMismatches(
      providerMembershipSnapshot.memberships,
      inventory.messageLabelMemberships,
    ).filter(
      (mismatch) =>
        !unavailableMembershipMessageIds.has(mismatch.providerMessageId),
    );

    const labelIds = new Set(inventory.providerLabelIds);
    const providerLabelIds = new Set(providerLabels.map((label) => label.id));
    const missingLabelIds = [...providerLabelIds].filter((id) => !labelIds.has(id));
    const extraLabelIds = [...labelIds].filter((id) => !providerLabelIds.has(id));
    const draftIds = new Set(inventory.providerDraftIds);
    const providerDraftIds = new Set(
      providerDrafts.map((draft) => draft.providerDraftId),
    );
    const missingDraftIds = [...providerDraftIds].filter((id) => !draftIds.has(id));
    const extraDraftIds = [...draftIds].filter((id) => !providerDraftIds.has(id));
    const additionalFailureCount =
      missingLabelIds.length +
      extraLabelIds.length +
      missingDraftIds.length +
      extraDraftIds.length +
      objectFailures.length +
      remainingMembershipMismatches.length +
      unavailableMembershipMessageIds.size;
    const repaired = await completeGmailReplicaAudit({
      auditId,
      providerMessageIds: repairedProviderMessageIds,
      storedMessageIds: inventory.providerMessageIds,
      additionalFailureCount,
      details: {
        repairedMissingMessageCount: missingMessageIds.length,
        repairedExtraMessageCount: extraMessageIds.length,
        repairedMessageLabelMembershipCount: membershipMismatches.length,
        missingLabelIds,
        extraLabelIds,
        messageLabelMembershipMismatches: remainingMembershipMismatches,
        unavailableMembershipMessageIds: Array.from(
          unavailableMembershipMessageIds,
        ),
        missingDraftIds,
        extraDraftIds,
        objectFailures,
      },
    });
    if (
      repaired.missing.length > 0 ||
      repaired.extra.length > 0 ||
      additionalFailureCount > 0
    ) {
      throw new Error("The Gmail replica completeness repair did not converge.");
    }
    return auditId;
  } catch (error) {
    await failGmailReplicaAudit({
      auditId,
      message: error instanceof Error ? error.message : "Unknown Gmail audit failure",
    });
    throw error;
  }
}

async function repairExpiredHistory(options: {
  accessToken: string;
  userId: string;
  accountId: string;
  accountEmail: string;
  expectedCursor: string;
  pushEventId?: string | null;
  markStoredPushEventsProcessed?: boolean;
}) {
  await setGmailReplicaState({ accountId: options.accountId, state: "repairing" });
  const baseline = await getGmailProfile(options.accessToken);
  await renewGmailWatch(options.accountId, options.accessToken);
  await syncGmailLabelCatalog({
    accessToken: options.accessToken,
    userId: options.userId,
    accountId: options.accountId,
  });
  await syncMailbox({
    accessToken: options.accessToken,
    userId: options.userId,
    accountId: options.accountId,
    accountEmail: options.accountEmail,
    ingestionMode: "initial",
  });
  const replay = await applyHistoryRange({
    ...options,
    startHistoryId: baseline.historyId,
    stateAfterApply: "repairing",
    ingestionMode: "initial",
  });
  if (!replay.applied) {
    throw new Error("The Gmail history cursor changed during completeness repair.");
  }
  await syncGmailDraftResources({
    accessToken: options.accessToken,
    userId: options.userId,
    accountId: options.accountId,
    accountEmail: options.accountEmail,
    ingestionMode: "initial",
  });
  const auditId = await runReplicaAudit({ ...options, trigger: "history_expired" });
  await markGmailReplicaReady({
    accountId: options.accountId,
    historyCursor: replay.historyId,
    auditId,
  });
  return { historyCursor: replay.historyId, auditId };
}

async function catchUpGmailHistory(options: {
  accountId: string;
  pushEventId?: string | null;
  resumeNonReady?: boolean;
  resumeFailedReplica?: boolean;
  markStoredPushEventsProcessed?: boolean;
}) {
  for (let conflictAttempt = 0; conflictAttempt < 3; conflictAttempt += 1) {
    const replica = await getGmailReplicaContext(options.accountId);
    if (!replica) throw new Error("The Gmail replica state was not found.");
    if (replica.state !== "ready") {
      if (shouldRepairNonReadyGmailReplica({
        isFailed: replica.state === "failed",
        resumeNonReady: options.resumeNonReady,
        resumeFailedReplica: options.resumeFailedReplica,
      })) {
        const { account, credential } = await getMailSyncContext(options.accountId);
        const expectedCursor = replica.historyCursor ?? replica.initialHistoryId;
        const repaired = await repairExpiredHistory({
          accessToken: credential.accessToken,
          userId: account.userId,
          accountId: account.id,
          accountEmail: account.email,
          expectedCursor,
          pushEventId: options.pushEventId,
          markStoredPushEventsProcessed: options.markStoredPushEventsProcessed,
        });
        return { status: "repaired", ...repaired, changedThreadCount: 0 };
      }
      return {
        status: "deferred",
        state: replica.state,
        historyCursor: replica.historyCursor,
      };
    }
    const { account, credential } = await getMailSyncContext(options.accountId);
    const expectedCursor = replica.historyCursor ?? replica.initialHistoryId;
    await syncGmailLabelCatalog({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      notify: true,
    });
    const replayOrRepair = await applyGmailHistoryWithExpiredCursorRepair({
      apply: () => applyHistoryRange({
        accessToken: credential.accessToken,
        userId: account.userId,
        accountId: account.id,
        accountEmail: account.email,
        startHistoryId: expectedCursor,
        expectedCursor,
        pushEventId: options.pushEventId,
        stateAfterApply: "ready",
        markStoredPushEventsProcessed: options.markStoredPushEventsProcessed,
        ingestionMode: "incremental",
      }),
      repair: () => repairExpiredHistory({
        accessToken: credential.accessToken,
        userId: account.userId,
        accountId: account.id,
        accountEmail: account.email,
        expectedCursor,
        pushEventId: options.pushEventId,
        markStoredPushEventsProcessed: options.markStoredPushEventsProcessed,
      }),
    });
    if (replayOrRepair.outcome === "repaired") {
      return {
        status: "repaired",
        ...replayOrRepair.result,
        changedThreadCount: 0,
      };
    }
    const replay = replayOrRepair.result;
    if (!replay.applied) continue;
    await syncGmailDraftResources({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      ingestionMode: "incremental",
      notify: true,
    });
    return {
      status: "complete",
      historyCursor: replay.historyId,
      changedThreadCount: replay.changedThreadIds.length,
    };
  }
  throw new Error("The Gmail history cursor changed repeatedly during catch-up.");
}

async function runGmailFinalize(job: WorkflowStepJob) {
  if (!job.accountId || !job.runId) {
    throw new Error("The Gmail finalization job is missing its synchronization run.");
  }
  const runId = requiredString(job.payload.runId, "Gmail synchronization run ID");
  if (!(await isActiveMailSyncRun({ runId, accountId: job.accountId }))) {
    return { status: "inactive", runId };
  }
  const replica = await getGmailReplicaContext(job.accountId);
  if (!replica) throw new Error("The Gmail replica state was not found.");
  const { account, credential } = await getMailSyncContext(job.accountId);
  const expectedCursor = replica.historyCursor ?? replica.initialHistoryId;
  await ensureGmailWatch(account.id, credential.accessToken);
  await setGmailReplicaState({ accountId: account.id, state: "replaying" });
  await syncGmailLabelCatalog({
    accessToken: credential.accessToken,
    userId: account.userId,
    accountId: account.id,
  });

  let historyCursor: string;
  let auditId: string;
  try {
    const replay = await applyHistoryRange({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      startHistoryId: replica.initialHistoryId,
      expectedCursor,
      stateAfterApply: "replaying",
      ingestionMode: "initial",
    });
    if (!replay.applied) {
      throw new Error("The Gmail history cursor changed during initial replay.");
    }
    historyCursor = replay.historyId;
    await syncGmailDraftResources({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      ingestionMode: "initial",
    });
    auditId = await runReplicaAudit({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      trigger: "initial",
    });
    await markGmailReplicaReady({ accountId: account.id, historyCursor, auditId });
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    const repaired = await repairExpiredHistory({
      accessToken: credential.accessToken,
      userId: account.userId,
      accountId: account.id,
      accountEmail: account.email,
      expectedCursor,
    });
    historyCursor = repaired.historyCursor;
    auditId = repaired.auditId;
  }

  const completed = await completeMailSyncRun({
    runId,
    finalHistoryCursor: historyCursor,
  });
  if (!completed) return { status: "inactive", runId };
  return { status: "complete", runId, historyCursor, auditId };
}

async function runGmailHistoryCatchup(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail history job has no account.");
  const pushEventId =
    typeof job.payload.pushEventId === "string" ? job.payload.pushEventId : null;
  const markStoredPushEventsProcessed =
    job.payload.reason === "post_initial_reconciliation";
  const result = await catchUpGmailHistory({
    accountId: job.accountId,
    pushEventId,
    resumeNonReady: job.attempts > 1,
    markStoredPushEventsProcessed,
  });
  if (result.status === "complete" || result.status === "repaired") {
    await enqueuePendingAnalysisWorkflowSteps();
  }
  return result;
}

async function runGmailWatchRenewal(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail watch renewal has no account.");
  const { account, credential } = await getMailSyncContext(job.accountId);
  const renewal = await runDailyGmailWatchRenewal({
    renew: () => renewGmailWatch(account.id, credential.accessToken),
    catchUp: () => catchUpGmailHistory({
      accountId: account.id,
      resumeNonReady: job.attempts > 1,
      resumeFailedReplica: true,
    }),
    scheduleNext: (renewedWatch) => enqueueDailyGmailWatchRenewal({
      userId: account.userId,
      accountId: account.id,
      renewedAt: renewedWatch.renewedAt,
      expectedExpirationAt: renewedWatch.expirationAt,
    }),
  });
  const catchup = renewal.catchup;
  if (catchup.status === "complete" || catchup.status === "repaired") {
    await enqueuePendingAnalysisWorkflowSteps();
  }
  return {
    ...catchup,
    nextRenewalStepId: renewal.nextRenewalStepId,
    watchExpirationAt: renewal.watch.expirationAt.toISOString(),
  };
}

async function runGmailReplicaAudit(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail replica audit has no account.");
  const catchup = await catchUpGmailHistory({
    accountId: job.accountId,
    resumeNonReady: true,
  });
  if (catchup.status === "deferred") return catchup;
  const { account, credential } = await getMailSyncContext(job.accountId);
  const auditId = await runReplicaAudit({
    accessToken: credential.accessToken,
    userId: account.userId,
    accountId: account.id,
    accountEmail: account.email,
    trigger: "manual",
  });
  const replica = await getGmailReplicaContext(account.id);
  const historyCursor = replica?.historyCursor ?? replica?.initialHistoryId;
  if (!historyCursor) throw new Error("The Gmail replica cursor was not found.");
  await markGmailReplicaReady({ accountId: account.id, historyCursor, auditId });
  return { status: "complete", historyCursor, auditId };
}

async function runGmailAccountCleanup(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Gmail cleanup has no account.");
  const cleanupId = requiredString(job.payload.cleanupId, "Gmail cleanup audit ID");
  await markGmailAccountCleanupRunning(cleanupId);
  const account = await getWorkerAccount(job.accountId);
  if (account) {
    const credential = decryptGoogleCredential(account.tokenCiphertext, encryptionKey);
    try {
      await stopGmailWatch(credential.accessToken);
    } catch (error) {
      if (
        !(error instanceof GmailApiError) ||
        ![400, 401, 403, 404].includes(error.status)
      ) {
        throw error;
      }
    }
  }
  const objectKeys = await listGmailObjectKeysForAccount(job.accountId);
  await objectStorage.deleteObjects(objectKeys);
  return { objectCount: objectKeys.length };
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
  pendingScope: {
    mode: "global" | "contact";
    contactEmail: string | null;
  } | null;
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
    throw new Error(`${name} is missing from the batch job.`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} is invalid in the batch job.`);
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
  let pendingScope: MemorySubmissionResult["pendingScope"] = null;
  if (result.pendingScope !== null && result.pendingScope !== undefined) {
    if (!result.pendingScope || typeof result.pendingScope !== "object") {
      throw new Error("The incremental Memory scope is invalid.");
    }
    const mode = "mode" in result.pendingScope ? result.pendingScope.mode : undefined;
    const contactEmail =
      "contactEmail" in result.pendingScope
        ? result.pendingScope.contactEmail
        : undefined;
    if (
      (mode !== "global" && mode !== "contact") ||
      (mode === "global" && contactEmail !== null) ||
      (mode === "contact" &&
        (typeof contactEmail !== "string" || !contactEmail.trim()))
    ) {
      throw new Error("The incremental Memory scope is invalid.");
    }
    pendingScope = {
      mode,
      contactEmail: mode === "contact" ? String(contactEmail) : null,
    };
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
    pendingScope,
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

async function clearMemoryEvidenceUsedByCandidates(
  accountId: string,
  memories: MessageMemoryCandidate[],
) {
  const evidenceByScope = new Map<
    string,
    {
      mode: "global" | "contact";
      contactEmail: string | null;
      messageIds: Set<string>;
    }
  >();
  for (const memory of memories) {
    const mode = memory.type === "contact" ? "contact" : "global";
    const contactEmail = mode === "contact" ? memory.contactEmail : null;
    if (mode === "contact" && !contactEmail) continue;
    const key = `${mode}:${contactEmail ?? ""}`;
    const scope = evidenceByScope.get(key) ?? {
      mode,
      contactEmail,
      messageIds: new Set<string>(),
    };
    for (const messageId of memory.evidenceMessageIds) {
      scope.messageIds.add(messageId);
    }
    evidenceByScope.set(key, scope);
  }

  await Promise.all(
    Array.from(evidenceByScope.values()).map((scope) =>
      clearPendingMemoryEvidence({
        accountId,
        mode: scope.mode,
        contactEmail: scope.contactEmail,
        messageIds: Array.from(scope.messageIds),
      }),
    ),
  );
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
    await enqueuePendingAnalysisWorkflowSteps();
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
    await enqueuePendingAnalysisWorkflowSteps();
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
    pendingScope: null,
    threadCount: threads.length,
    evidenceMessageCount,
  };
}

async function runIncrementalMemoryExtraction(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The incremental Memory job has no account.");
  if (job.payload.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return {
      status: "superseded",
      requestedSchemaVersion: job.payload.schemaVersion ?? null,
      currentSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }
  const mode = job.payload.mode;
  const contactEmail = job.payload.contactEmail;
  const evidenceMessageIds = job.payload.evidenceMessageIds;
  if (
    (mode !== "global" && mode !== "contact") ||
    (mode === "global" && contactEmail !== null) ||
    (mode === "contact" &&
      (typeof contactEmail !== "string" || !contactEmail.trim())) ||
    !Array.isArray(evidenceMessageIds) ||
    evidenceMessageIds.some((id) => typeof id !== "string")
  ) {
    throw new Error("The incremental Memory evidence scope is invalid.");
  }
  const normalizedContactEmail =
    mode === "contact" ? String(contactEmail).trim().toLowerCase() : null;

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id, evidenceMessageIds),
    account.email,
  );
  const availableEvidenceIds = new Set(
    threads.flatMap((thread) =>
      thread.messages
        .filter((message) => message.ownerEvidence)
        .map((message) => message.id),
    ),
  );
  const currentEvidenceMessageIds = evidenceMessageIds.filter((id) =>
    availableEvidenceIds.has(id),
  );
  if (currentEvidenceMessageIds.length < 3) {
    return {
      status: "waiting_for_repetition",
      evidenceMessageCount: currentEvidenceMessageIds.length,
    };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  const submission = await submitMemoryBatch({
    submissionId: job.id,
    batchAttempt: 1,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    scopeSelection: {
      mode,
      contactEmail: normalizedContactEmail,
    },
  });
  if (!submission) {
    throw new Error("The incremental Memory Batch produced no requests.");
  }
  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    replaceExisting: false,
    pendingScope: {
      mode,
      contactEmail: normalizedContactEmail,
    },
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
    pendingScope: parentDetails.pendingScope,
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
      markComplete:
        details.pendingScope === null && failedManifest.length === 0,
    });
    await clearMemoryEvidenceUsedByCandidates(submission.accountId, memories);

    if (details.pendingScope === null && failedManifest.length === 0) {
      await enqueuePendingAnalysisWorkflowSteps();
    }
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
  } else if (!hasSuccessfulRequests && details.pendingScope === null) {
    await setMemorySyncStage(submission.accountId, "complete");
  }

  const cleanupFailures = await deleteBatchFiles({
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

type LabelSubmissionResult = {
  provider: BatchProvider;
  providerBatchId: string;
  inputFileId: string;
  modelId: string;
  requestCount: number;
  manifest: LabelBatchManifestEntry[];
  batchAttempt: number;
  rootSubmissionJobId: string;
  labelId: string;
  definitionVersion: number;
  continueBackfill: boolean;
};

function parseLabelManifest(value: unknown): LabelBatchManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("The label Batch manifest is missing.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("The label Batch manifest is invalid.");
    }
    const key = "key" in entry ? entry.key : undefined;
    const labelId = "labelId" in entry ? entry.labelId : undefined;
    const definitionVersion =
      "definitionVersion" in entry ? entry.definitionVersion : undefined;
    const threadId = "threadId" in entry ? entry.threadId : undefined;
    const threadVersion = "threadVersion" in entry ? entry.threadVersion : undefined;
    if (
      typeof key !== "string" ||
      typeof labelId !== "string" ||
      typeof definitionVersion !== "number" ||
      !Number.isInteger(definitionVersion) ||
      definitionVersion < 1 ||
      typeof threadId !== "string" ||
      typeof threadVersion !== "number" ||
      !Number.isInteger(threadVersion) ||
      threadVersion < 1
    ) {
      throw new Error("The label Batch manifest is invalid.");
    }
    return { key, labelId, definitionVersion, threadId, threadVersion };
  });
}

function parseLabelSubmissionResult(value: unknown): LabelSubmissionResult | null {
  if (!value || typeof value !== "object") {
    throw new Error("The label Batch submission result is missing.");
  }
  const result = value as Record<string, unknown>;
  if (!batchProviders.includes(result.provider as BatchProvider)) {
    return null;
  }
  if (typeof result.continueBackfill !== "boolean") {
    throw new Error("The label Batch continuation state is missing.");
  }
  const manifest = parseLabelManifest(result.manifest);
  const requestCount = requiredInteger(result.requestCount, "Label Batch request count");
  const labelId = requiredString(result.labelId, "Label ID");
  const definitionVersion = requiredInteger(
    result.definitionVersion,
    "Label definition version",
  );
  if (
    manifest.length !== requestCount ||
    new Set(manifest.map((entry) => entry.key)).size !== manifest.length ||
    manifest.some(
      (entry) =>
        entry.labelId !== labelId || entry.definitionVersion !== definitionVersion,
    )
  ) {
    throw new Error("The label Batch manifest does not match its request count or label.");
  }
  return {
    provider: result.provider as BatchProvider,
    providerBatchId: requiredString(result.providerBatchId, "Provider batch ID"),
    inputFileId: requiredString(result.inputFileId, "Provider input file"),
    modelId: requiredString(result.modelId, "Label Batch model"),
    requestCount,
    manifest,
    batchAttempt: requiredInteger(result.batchAttempt, "Label Batch attempt"),
    rootSubmissionJobId: requiredString(
      result.rootSubmissionJobId,
      "Root label submission job ID",
    ),
    labelId,
    definitionVersion,
    continueBackfill: result.continueBackfill,
  };
}

async function cleanupLabelBatchFiles(input: {
  provider: BatchProvider;
  inputFileId: string;
  outputFileId: string | null;
  errorFileId: string | null;
  submissionJobId: string;
}) {
  const failures = await deleteBatchFiles({
    provider: input.provider,
    inputFileId: input.inputFileId,
    outputFileId: input.outputFileId,
    errorFileId: input.errorFileId,
  });
  if (failures.length > 0) {
    console.error("worker: label Batch files could not be deleted", {
      provider: input.provider,
      submissionJobId: input.submissionJobId,
      fileCount: failures.length,
    });
  }
}

async function runLabelBackfill(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The label backfill has no connected account.");
  const labelId = requiredString(job.payload.labelId, "Label ID");
  const definitionVersion = requiredInteger(
    job.payload.definitionVersion,
    "Label definition version",
  );
  const label = await getLabelForAnalysis(job.accountId, labelId);
  if (!label || label.definitionVersion !== definitionVersion) {
    return { status: "superseded", labelId, definitionVersion };
  }
  const threads = await getThreadsForLabelBackfill({
    accountId: job.accountId,
    labelId,
    definitionVersion,
  });
  if (threads.length === 0) {
    await setLabelAnalysisState({
      accountId: job.accountId,
      labelId,
      definitionVersion,
      state: "complete",
    });
    return { status: "complete", labelId, definitionVersion, threadCount: 0 };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  await setLabelAnalysisState({
    accountId: job.accountId,
    labelId,
    definitionVersion,
    state: "running",
  });
  const submission = await submitLabelBatch({
    submissionId: job.id,
    batchAttempt: 1,
    label,
    threads: threads satisfies LabelAnalysisThread[],
  });
  if (!submission) throw new Error("The label Batch produced no requests.");

  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    labelId,
    definitionVersion,
    continueBackfill: true,
  };
}

async function runLabelBatchRetry(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The label Batch retry has no connected account.");
  const parentSubmissionJobId = requiredString(
    job.payload.parentSubmissionJobId,
    "Parent label submission job ID",
  );
  const parentSubmission = await getLabelBatchSubmission(parentSubmissionJobId);
  if (parentSubmission?.accountId !== job.accountId) {
    throw new Error("The parent label submission could not be matched to this account.");
  }
  const parentDetails = parseLabelSubmissionResult(parentSubmission.result);
  if (!parentDetails) return { status: "superseded", provider: "unsupported" };
  if (!isMemoryBatchProviderConfigured(parentDetails.provider)) {
    throw new MemoryBatchConfigurationError(
      `The ${parentDetails.provider} provider used by this label Batch retry is not configured.`,
    );
  }

  const labelId = requiredString(job.payload.labelId, "Label ID");
  const definitionVersion = requiredInteger(
    job.payload.definitionVersion,
    "Label definition version",
  );
  const label = await getLabelForAnalysis(job.accountId, labelId);
  if (!label || label.definitionVersion !== definitionVersion) {
    return { status: "superseded", labelId, definitionVersion };
  }
  const manifest = parseLabelManifest(job.payload.manifest);
  const threads = await getThreadsForLabelRetry(
    job.accountId,
    manifest.map((entry) => entry.threadId),
  );
  const batchAttempt = requiredInteger(job.payload.batchAttempt, "Label Batch attempt");
  const rootSubmissionJobId = requiredString(
    job.payload.rootSubmissionJobId,
    "Root label submission job ID",
  );
  if (typeof job.payload.continueBackfill !== "boolean") {
    throw new Error("The label Batch continuation state is missing.");
  }
  const submission = await submitLabelBatch({
    provider: parentDetails.provider,
    submissionId: job.id,
    batchAttempt,
    label,
    threads: threads satisfies LabelAnalysisThread[],
    retryManifest: manifest,
  });
  if (!submission) throw new Error("The label Batch retry produced no requests.");

  return {
    status: "submitted",
    ...submission,
    batchAttempt,
    rootSubmissionJobId,
    labelId,
    definitionVersion,
    continueBackfill: job.payload.continueBackfill,
  };
}

async function runLabelBatchEvent(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The label Batch event has no account.");
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "Label submission job ID",
  );
  const submission = await getLabelBatchSubmission(submissionJobId);
  if (!submission?.accountId || !submission.userId || submission.accountId !== job.accountId) {
    throw new Error("The label Batch submission could not be matched to this account.");
  }
  const details = parseLabelSubmissionResult(submission.result);
  if (!details) return { status: "superseded", provider: "unsupported" };
  const providerBatchId = requiredString(
    job.payload.providerBatchId,
    "Provider event batch ID",
  );
  if (
    job.payload.provider !== details.provider ||
    providerBatchId !== details.providerBatchId
  ) {
    throw new Error("The provider event does not match its label submission.");
  }

  const batch = await readLabelBatch({
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
      `${details.provider} emitted a terminal event while the label Batch is ${batch.state}.`,
    );
  }

  const currentLabel = await getLabelForAnalysis(
    submission.accountId,
    details.labelId,
  );
  if (!currentLabel || currentLabel.definitionVersion !== details.definitionVersion) {
    await cleanupLabelBatchFiles({
      provider: details.provider,
      inputFileId: details.inputFileId,
      outputFileId: batch.outputFileId,
      errorFileId: batch.errorFileId,
      submissionJobId: submission.id,
    });
    return { status: "superseded", reason: "label_deleted" };
  }

  const currentThreads = await getThreadsForLabelRetry(
    submission.accountId,
    details.manifest.map((entry) => entry.threadId),
  );
  const currentVersions = new Map(
    currentThreads.map((thread) => [thread.id, thread.contentVersion]),
  );
  const staleKeys = new Set(
    details.manifest
      .filter(
        (entry) =>
          currentVersions.get(entry.threadId) !== entry.threadVersion,
      )
      .map((entry) => entry.key),
  );
  const failedKeys = new Set(batch.failedKeys);
  const results: Array<{
    threadId: string;
    threadVersion: number;
    matched: boolean;
    confidence: number;
  }> = [];
  let savedThreadCount = 0;
  for (const entry of details.manifest) {
    if (staleKeys.has(entry.key)) continue;
    if (failedKeys.has(entry.key)) continue;
    const candidate = batch.candidatesByKey.get(entry.key);
    if (
      !candidate ||
      candidate.threadId !== entry.threadId ||
      candidate.labelId !== entry.labelId
    ) {
      failedKeys.add(entry.key);
      continue;
    }
    results.push({
      threadId: candidate.threadId,
      threadVersion: entry.threadVersion,
      matched: candidate.matched,
      confidence: candidate.confidence,
    });
  }
  if (results.length > 0) {
    const saved = await saveLabelBatchResults({
      userId: submission.userId,
      accountId: submission.accountId,
      labelId: details.labelId,
      definitionVersion: details.definitionVersion,
      modelId: batch.modelId,
      results,
    });
    if (!saved) {
      await cleanupLabelBatchFiles({
        provider: details.provider,
        inputFileId: details.inputFileId,
        outputFileId: batch.outputFileId,
        errorFileId: batch.errorFileId,
        submissionJobId: submission.id,
      });
      return { status: "superseded", reason: "label_deleted" };
    }
    for (const threadId of saved.staleThreadIds) {
      const entry = details.manifest.find((candidate) => candidate.threadId === threadId);
      if (entry) staleKeys.add(entry.key);
    }
    savedThreadCount = saved.savedThreadCount;
  }

  const failedManifest = details.manifest.filter(
    (entry) => failedKeys.has(entry.key) && !staleKeys.has(entry.key),
  );
  let nextJobId: string | null = null;
  if (failedManifest.length > 0 && details.batchAttempt < submission.maxAttempts) {
    nextJobId = await enqueueLabelBatchRetry({
      userId: submission.userId,
      accountId: submission.accountId,
      labelId: details.labelId,
      definitionVersion: details.definitionVersion,
      parentSubmissionJobId: submission.id,
      rootSubmissionJobId: details.rootSubmissionJobId,
      batchAttempt: details.batchAttempt + 1,
      continueBackfill: details.continueBackfill,
      manifest: failedManifest,
    });
  } else if (failedManifest.length > 0) {
    await setLabelAnalysisState({
      accountId: submission.accountId,
      labelId: details.labelId,
      definitionVersion: details.definitionVersion,
      state: "failed",
    });
  } else if (details.continueBackfill || staleKeys.size > 0) {
    nextJobId = await enqueueLabelBackfillContinuation({
      userId: submission.userId,
      accountId: submission.accountId,
      labelId: details.labelId,
      definitionVersion: details.definitionVersion,
      parentSubmissionJobId: submission.id,
    });
  } else {
    await setLabelAnalysisState({
      accountId: submission.accountId,
      labelId: details.labelId,
      definitionVersion: details.definitionVersion,
      state: "complete",
    });
  }

  await cleanupLabelBatchFiles({
    provider: details.provider,
    inputFileId: details.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
    submissionJobId: submission.id,
  });

  return {
    status:
      failedManifest.length === 0
        ? nextJobId
          ? "continuation_queued"
          : "complete"
        : nextJobId
          ? "retry_submitted"
          : "failed",
    providerState: batch.state,
    provider: details.provider,
    providerError: batch.providerError,
    analyzedThreadCount: savedThreadCount,
    staleThreadCount: staleKeys.size,
    failedRequestCount: failedManifest.length,
    nextJobId,
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
  if (terminal && job.stepType === "gmail.watch.renew" && job.accountId) {
    await ensureDailyGmailWatchRenewals({
      accountId: job.accountId,
      recoveryForStepId: job.id,
    });
  }
  if (job.stepType === "gmail.sync.message" && job.runId) {
    await failMailSyncItem({
      runId: job.runId,
      providerMessageId: requiredString(
        job.payload.providerMessageId,
        "Gmail message ID",
      ),
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
    attempts: bullJob.data.attempts + Math.max(bullJob.attemptsMade, 1),
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
  if (!started.shouldExecute) return started.result;
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
  const execute = () =>
    executeWorkflowJob(bullJob, async (job) => {
      if (job.stepType === "gmail.sync.page") return runGmailPage(job);
      if (job.stepType === "gmail.sync.finalize") return runGmailFinalize(job);
      throw new Error(`Unsupported Gmail page step: ${job.stepType}`);
    });
  const accountId = bullJob.data.accountId;
  return bullJob.name === "gmail.sync.finalize" && accountId
    ? withGmailAccountControlLock(accountId, execute)
    : execute();
}

function processGmailMessage(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, runGmailMessage);
}

function processGmailControl(bullJob: WorkflowJob) {
  const execute = () =>
    executeWorkflowJob(bullJob, async (job) => {
      if (!job.accountId) throw new Error("The Gmail control step has no account.");
      if (job.stepType === "gmail.history.catchup") {
        return runGmailHistoryCatchup(job);
      }
      if (job.stepType === "gmail.watch.renew") return runGmailWatchRenewal(job);
      if (job.stepType === "gmail.replica.audit") return runGmailReplicaAudit(job);
      if (job.stepType === "gmail.account.cleanup") {
        return runGmailAccountCleanup(job);
      }
      throw new Error(`Unsupported Gmail control step: ${job.stepType}`);
    });
  const accountId = bullJob.data.accountId;
  return accountId ? withGmailAccountControlLock(accountId, execute) : execute();
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
  return executeWorkflowJob(bullJob, async (job) => {
    if (job.stepType === "memory.extract") return runMemoryExtraction(job);
    if (job.stepType === "memory.incremental") {
      return runIncrementalMemoryExtraction(job);
    }
    throw new Error(`Unsupported Memory submission step: ${job.stepType}`);
  });
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

function processLabelSubmission(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, runLabelBackfill);
}

function processLabelEvent(bullJob: WorkflowJob) {
  return executeWorkflowJob(bullJob, async (job) => {
    if (job.stepType === "label.batch.retry") return runLabelBatchRetry(job);
    if (job.stepType === "label.batch.event") return runLabelBatchEvent(job);
    throw new Error(`Unsupported label Batch step: ${job.stepType}`);
  });
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
  runtime.createWorker(
    "gmail-control",
    processGmailControl,
    {
      ...withFailureReconciliation,
      concurrency: gmailControlConcurrency,
    },
  );
  if (isAiConfigured()) {
    runtime.createWorker(
      "mail-memory-feedback",
      processMemoryFeedback,
      withFailureReconciliation,
    );
  }
  if (isEmbeddingBatchConfigured()) {
    runtime.createWorker("mail-indexing-batch", processIndexingBatch, {
      ...withFailureReconciliation,
      lockDuration: batchWorkerLockDuration,
    });
  }
  if (isEmbeddingConfigured()) {
    runtime.createWorker("mail-indexing-live", processIncrementalIndexing, {
      ...withFailureReconciliation,
      concurrency: 5,
    });
  }
  if (isMemoryBatchConfigured()) {
    runtime.createWorker("mail-memory-submit", processMemorySubmission, {
      ...withFailureReconciliation,
      lockDuration: batchWorkerLockDuration,
    });
    runtime.createWorker("mail-label-submit", processLabelSubmission, {
      ...withFailureReconciliation,
      lockDuration: batchWorkerLockDuration,
    });
  }
  if (isAnyMemoryBatchProviderConfigured()) {
    runtime.createWorker(
      "mail-memory-events",
      processMemoryEvent,
      withFailureReconciliation,
    );
    runtime.createWorker(
      "mail-label-events",
      processLabelEvent,
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

async function runOutboxLoop(
  signal: ReturnType<typeof createJobSignal>,
  isStopped: () => boolean,
  runtime: BullQueueRuntime,
) {
  while (!isStopped()) {
    await signal.wait();
    if (isStopped()) break;
    while (!isStopped()) {
      const result = await publishOutboxBatch((jobs) => runtime.publish(jobs));
      if (result.failed || result.published === 0) break;
    }
  }
}

async function run() {
  const runtime = new BullQueueRuntime(process.env.REDIS_URL ?? "");
  await runtime.waitUntilReady();
  await runtime.configureGlobalConcurrency();
  startBullWorkers(runtime);

  const outboxSignal = createJobSignal();
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
    outboxSignal.notify();
  };
  const stopOutboxListening = await listenForOutboxNotifications(outboxSignal.notify);
  const stopRedisReadyListener = runtime.onReady(outboxSignal.notify);

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await enqueueMissingMailSyncRuns();
    await enqueueReadyMailSyncFinalizers();
    await ensureDailyGmailWatchRenewals();
    await enqueuePostSyncWorkflowSteps();
    await enqueuePendingAnalysisWorkflowSteps();
    await reconcileSubmittedEmbeddingBatches();
    outboxSignal.notify();
    await runOutboxLoop(outboxSignal, () => stopRequested, runtime);
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    stopRedisReadyListener();
    await stopOutboxListening();
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
