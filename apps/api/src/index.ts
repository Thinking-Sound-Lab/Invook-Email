import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  invookLabelKeys,
  type AccountSyncStage,
  type IndexingStatusEvent,
  type MemoryGenerationProgress,
  type InvookLabelKey,
  type MailboxWorkspace,
  type SessionState,
} from "@invook/contracts";
import {
  getMemoryBatchRequestProgress,
  isAiConfigured,
  batchProviders,
  type BatchProvider,
} from "@invook/ai";
import {
  checkDatabaseConnection,
  decryptGoogleCredential,
  encryptGoogleCredential,
  getGmailConnectionForOAuth,
  getIndexingSyncStateForUser,
  getMailboxWorkspace,
  hasConnectedGmailAccount,
  listenForAccountSyncNotifications,
  saveGmailConnection,
  setUserThreadLabel,
} from "@invook/database";
import {
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  getGmailProfile,
  GmailApiError,
} from "@invook/gmail";

import {
  clearOAuthRequestCookies,
  createOAuthRequestCookies,
  createOAuthState,
  getInvookUserId,
  isMatchingOAuthState,
  readOAuthRequest,
} from "./auth/oauth-state";
import {
  clearSessionCookie,
  createSessionCookie,
  getCurrentSession,
} from "./auth/session";
import {
  getApiHost,
  getApiPort,
  getMissingApiConfiguration,
  getPublicAppOrigin,
} from "./config";
import {
  getRequestUrl,
  hasAllowedMutationOrigin,
  readJsonBody,
} from "./http/request";
import { sendJson, sendProblem, sendRedirect } from "./http/responses";
import { handleGenerateDraft, handleUpdateDraft } from "./routes/drafts";
import { handleMailAgent } from "./routes/agent";
import { handleBatchWebhook } from "./routes/batch-webhook";
import {
  handleCreateMemory,
  handleDeleteMemory,
  handleGetMemories,
  handleUpdateMemory,
} from "./routes/memories";
import { searchMailForUser } from "./services/search";

type ConnectionErrorReason =
  | "authorization"
  | "configuration"
  | "gmail_access"
  | "offline_access"
  | "unknown";

const indexingStages = new Set<AccountSyncStage>([
  "pending",
  "running",
  "complete",
  "failed",
]);
const indexingStreams = new Map<string, Set<ServerResponse>>();

function parseIndexingNotification(
  payload: string,
): { accountId: string; state: AccountSyncStage } | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (
      typeof value.accountId !== "string" ||
      typeof value.state !== "string" ||
      !indexingStages.has(value.state as AccountSyncStage)
    ) {
      return null;
    }
    return { accountId: value.accountId, state: value.state as AccountSyncStage };
  } catch {
    return null;
  }
}

function writeIndexingEvent(response: ServerResponse, state: AccountSyncStage) {
  const event: IndexingStatusEvent = { state };
  response.write(`event: indexing\ndata: ${JSON.stringify(event)}\n\n`);
}

function broadcastIndexingNotification(payload: string) {
  const notification = parseIndexingNotification(payload);
  if (!notification) return;
  const streams = indexingStreams.get(notification.accountId);
  if (!streams) return;
  for (const response of streams) {
    if (!response.destroyed && !response.writableEnded) {
      writeIndexingEvent(response, notification.state);
    }
  }
}

function connectionErrorUrl(reason: ConnectionErrorReason): string {
  const target = new URL("/auth/error", getPublicAppOrigin());
  target.searchParams.set("reason", reason);
  return target.toString();
}

function resultNumber(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

async function serializeMemoryProgress(
  workspace: NonNullable<Awaited<ReturnType<typeof getMailboxWorkspace>>>,
): Promise<MemoryGenerationProgress> {
  const memoryCount = workspace.memories.length;
  const submission = workspace.memoryBatchSubmission;
  const requestCount = resultNumber(submission, "requestCount");
  const evidenceMessageCount = resultNumber(submission, "evidenceMessageCount");

  if (
    workspace.account.syncState.mailSync === "pending" ||
    workspace.account.syncState.mailSync === "running"
  ) {
    return {
      stage: "waiting_for_mail",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: null,
      evidenceMessageCount,
      memoryCount,
    };
  }

  if (workspace.account.syncState.memory === "complete") {
    return {
      stage: "complete",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }

  if (workspace.account.syncState.memory === "failed") {
    return {
      stage: "failed",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }

  const provider = submission?.provider;
  const providerBatchId = submission?.providerBatchId;
  if (
    typeof provider !== "string" ||
    !batchProviders.includes(provider as BatchProvider) ||
    typeof providerBatchId !== "string" ||
    !providerBatchId
  ) {
    return {
      stage: "preparing",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }

  try {
    const progress = await getMemoryBatchRequestProgress({
      provider: provider as BatchProvider,
      providerBatchId,
    });
    const stage =
      progress.state === "validating"
        ? "validating"
        : progress.state === "in_progress"
          ? "analyzing"
          : progress.state === "finalizing" ||
              progress.state === "completed" ||
              progress.state === "cancelling"
            ? "finalizing"
            : "failed";

    return {
      stage,
      completedRequestCount: progress.completedRequestCount,
      failedRequestCount: progress.failedRequestCount,
      totalRequestCount: progress.totalRequestCount ?? requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  } catch {
    return {
      stage: "validating",
      completedRequestCount: null,
      failedRequestCount: null,
      totalRequestCount: requestCount,
      evidenceMessageCount,
      memoryCount,
    };
  }
}

async function serializeWorkspace(
  workspace: NonNullable<Awaited<ReturnType<typeof getMailboxWorkspace>>>,
): Promise<MailboxWorkspace> {
  return {
    aiConfigured: isAiConfigured(),
    account: {
      ...workspace.account,
      lastSyncedAt: workspace.account.lastSyncedAt?.toISOString() ?? null,
    },
    memoryProgress: await serializeMemoryProgress(workspace),
    memories: workspace.memories,
    threads: workspace.threads.map((thread) => ({
      ...thread,
      latestMessageAt: thread.latestMessageAt?.toISOString() ?? null,
    })),
    selectedThread: workspace.selectedThread
      ? {
          ...workspace.selectedThread,
          latestMessageAt:
            workspace.selectedThread.latestMessageAt?.toISOString() ?? null,
          messages: workspace.selectedThread.messages.map((message) => ({
            ...message,
            sentAt: message.sentAt.toISOString(),
          })),
        }
      : null,
  };
}

async function handleGoogleStart(response: ServerResponse, requestId: string) {
  if (getMissingApiConfiguration().length > 0) {
    sendRedirect(response, requestId, connectionErrorUrl("configuration"), 302);
    return;
  }

  const state = createOAuthState();
  const authorization = await createGoogleAuthorizationRequest({
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: `${getPublicAppOrigin()}/auth/callback`,
    state,
  });

  sendRedirect(
    response,
    requestId,
    authorization.url,
    302,
    createOAuthRequestCookies(state, authorization.codeVerifier),
  );
}

async function handleGoogleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  requestUrl: URL,
) {
  const providerError = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");
  const returnedState = requestUrl.searchParams.get("state");
  const oauthRequest = readOAuthRequest(request);

  if (
    providerError ||
    !code ||
    !oauthRequest.codeVerifier ||
    !isMatchingOAuthState(oauthRequest.state, returnedState)
  ) {
    sendRedirect(
      response,
      requestId,
      connectionErrorUrl("authorization"),
      302,
      clearOAuthRequestCookies(),
    );
    return;
  }

  try {
    const authorization = await exchangeGoogleAuthorizationCode({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirectUri: `${getPublicAppOrigin()}/auth/callback`,
      code,
      codeVerifier: oauthRequest.codeVerifier,
    });
    const gmailProfile = await getGmailProfile(authorization.accessToken);
    const providerAccountId = authorization.identity.subject;
    const userId = getInvookUserId(providerAccountId);
    const existingAccount = await getGmailConnectionForOAuth(providerAccountId);
    if (existingAccount && existingAccount.userId !== userId) {
      throw new Error("This Gmail account is already linked to another Invook user.");
    }

    let refreshToken = authorization.refreshToken;
    if (!refreshToken && existingAccount?.tokenCiphertext) {
      refreshToken = decryptGoogleCredential(
        existingAccount.tokenCiphertext,
        process.env.TOKEN_ENCRYPTION_KEY ?? "",
      ).refreshToken;
    }
    if (!refreshToken) {
      sendRedirect(
        response,
        requestId,
        connectionErrorUrl("offline_access"),
        302,
        clearOAuthRequestCookies(),
      );
      return;
    }

    const acknowledgedAt = new Date();
    const tokenCiphertext = encryptGoogleCredential(
      {
        accessToken: authorization.accessToken,
        refreshToken,
        expiresAt: authorization.expiresAt,
        scopes: authorization.scopes,
      },
      process.env.TOKEN_ENCRYPTION_KEY ?? "",
    );
    await saveGmailConnection({
      userId,
      displayName: authorization.identity.displayName,
      providerAccountId,
      email: gmailProfile.emailAddress,
      scopes: authorization.scopes,
      historyCursor: gmailProfile.historyId,
      tokenCiphertext,
      acknowledgedAt,
    });

    sendRedirect(
      response,
      requestId,
      new URL("/mail", getPublicAppOrigin()).toString(),
      302,
      [
        ...clearOAuthRequestCookies(),
        createSessionCookie({ userId, googleSubject: providerAccountId }),
      ],
    );
  } catch (error) {
    console.error("api: gmail oauth callback failed", {
      requestId,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown callback failure",
      status: error instanceof GmailApiError ? error.status : undefined,
    });
    sendRedirect(
      response,
      requestId,
      connectionErrorUrl(
        error instanceof GmailApiError && error.status === 403
          ? "gmail_access"
          : "unknown",
      ),
      302,
      clearOAuthRequestCookies(),
    );
  }
}

async function handleSession(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const session = getCurrentSession(request);
  if (!session) {
    const state: SessionState = { authenticated: false, gmailConnected: false };
    sendJson(response, requestId, 200, state);
    return;
  }

  const state: SessionState = {
    authenticated: true,
    gmailConnected: await hasConnectedGmailAccount(session.userId),
  };
  sendJson(response, requestId, 200, state);
}

async function handleMailbox(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  requestUrl: URL,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return;
  }

  const threadId = requestUrl.searchParams.get("thread")?.trim() || undefined;
  const workspace = await getMailboxWorkspace(session.userId, threadId);
  if (!workspace) {
    sendProblem(response, requestId, 404, "Connected Gmail account not found");
    return;
  }

  sendJson(response, requestId, 200, await serializeWorkspace(workspace));
}

async function handleIndexingEvents(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return;
  }

  const indexing = await getIndexingSyncStateForUser(session.userId);
  if (!indexing) {
    sendProblem(response, requestId, 404, "Connected Gmail account not found");
    return;
  }

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-request-id", requestId);
  response.flushHeaders();

  const accountStreams = indexingStreams.get(indexing.accountId) ?? new Set();
  accountStreams.add(response);
  indexingStreams.set(indexing.accountId, accountStreams);

  let closed = false;
  const removeStream = () => {
    if (closed) return;
    closed = true;
    accountStreams.delete(response);
    if (accountStreams.size === 0) indexingStreams.delete(indexing.accountId);
  };
  request.once("close", removeStream);
  response.once("close", removeStream);
  writeIndexingEvent(response, indexing.state);
}

async function handleMailSearch(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  requestUrl: URL,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return;
  }
  const query = requestUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 1_000) {
    sendProblem(response, requestId, 400, "A valid mail search query is required");
    return;
  }

  const results = await searchMailForUser({
    userId: session.userId,
    query,
    onSemanticError: (error) => {
      console.error("api: semantic mail search unavailable", {
        requestId,
        name: error instanceof Error ? error.name : "UnknownError",
      });
    },
  });
  sendJson(response, requestId, 200, { results });
}

async function handleThreadLabel(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  threadId: string,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return;
  }

  if (!hasAllowedMutationOrigin(request)) {
    sendProblem(response, requestId, 403, "Request origin is not allowed");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    sendProblem(response, requestId, 400, "Invalid JSON request body");
    return;
  }
  if (!body || typeof body !== "object") {
    sendProblem(response, requestId, 400, "A label decision is required");
    return;
  }

  const label = "label" in body ? body.label : undefined;
  const applied = "applied" in body ? body.applied : undefined;
  if (
    typeof label !== "string" ||
    !invookLabelKeys.includes(label as InvookLabelKey) ||
    typeof applied !== "boolean"
  ) {
    sendProblem(response, requestId, 400, "Label and applied must be valid");
    return;
  }

  const labels = await setUserThreadLabel({
    userId: session.userId,
    threadId,
    label: label as InvookLabelKey,
    applied,
  });
  if (!labels) {
    sendProblem(response, requestId, 404, "Email thread not found");
    return;
  }

  sendJson(response, requestId, 200, { labels });
}

async function routeRequest(request: IncomingMessage, response: ServerResponse) {
  const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
  const requestUrl = getRequestUrl(request);
  const pathname = requestUrl.pathname.replace(/\/$/, "") || "/";

  try {
    if (request.method === "GET" && pathname === "/health/live") {
      sendJson(response, requestId, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && pathname === "/health/ready") {
      const missing = getMissingApiConfiguration();
      if (missing.length > 0) {
        sendProblem(response, requestId, 503, "API configuration is incomplete");
        return;
      }
      await checkDatabaseConnection();
      sendJson(response, requestId, 200, { status: "ready" });
      return;
    }

    if (request.method === "POST" && pathname === "/v1/webhooks/openai") {
      await handleBatchWebhook(request, response, requestId, "openai");
      return;
    }

    if (
      request.method === "POST" &&
      pathname === "/v1/webhooks/azure-openai"
    ) {
      await handleBatchWebhook(
        request,
        response,
        requestId,
        "azure-openai",
      );
      return;
    }

    if (request.method === "GET" && pathname === "/v1/auth/google/start") {
      await handleGoogleStart(response, requestId);
      return;
    }

    if (request.method === "GET" && pathname === "/v1/auth/google/callback") {
      await handleGoogleCallback(request, response, requestId, requestUrl);
      return;
    }

    if (request.method === "POST" && pathname === "/v1/auth/sign-out") {
      sendRedirect(
        response,
        requestId,
        new URL("/", getPublicAppOrigin()).toString(),
        303,
        [clearSessionCookie()],
      );
      return;
    }

    if (request.method === "GET" && pathname === "/v1/session") {
      await handleSession(request, response, requestId);
      return;
    }

    if (request.method === "GET" && pathname === "/v1/mailbox") {
      await handleMailbox(request, response, requestId, requestUrl);
      return;
    }

    if (request.method === "GET" && pathname === "/v1/indexing/events") {
      await handleIndexingEvents(request, response, requestId);
      return;
    }

    if (request.method === "GET" && pathname === "/v1/mail/search") {
      await handleMailSearch(request, response, requestId, requestUrl);
      return;
    }

    if (request.method === "POST" && pathname === "/v1/agent") {
      await handleMailAgent(request, response, requestId);
      return;
    }

    if (request.method === "GET" && pathname === "/v1/memories") {
      await handleGetMemories(request, response, requestId);
      return;
    }

    if (request.method === "POST" && pathname === "/v1/memories") {
      await handleCreateMemory(request, response, requestId);
      return;
    }

    const memoryMatch = pathname.match(/^\/v1\/memories\/([^/]+)$/);
    if (request.method === "PATCH" && memoryMatch?.[1]) {
      await handleUpdateMemory(
        request,
        response,
        requestId,
        decodeURIComponent(memoryMatch[1]),
      );
      return;
    }
    if (request.method === "DELETE" && memoryMatch?.[1]) {
      await handleDeleteMemory(
        request,
        response,
        requestId,
        decodeURIComponent(memoryMatch[1]),
      );
      return;
    }

    const threadLabelMatch = pathname.match(/^\/v1\/threads\/([^/]+)\/labels$/);
    if (request.method === "PATCH" && threadLabelMatch?.[1]) {
      await handleThreadLabel(
        request,
        response,
        requestId,
        decodeURIComponent(threadLabelMatch[1]),
      );
      return;
    }

    const threadDraftMatch = pathname.match(/^\/v1\/threads\/([^/]+)\/drafts$/);
    if (request.method === "POST" && threadDraftMatch?.[1]) {
      await handleGenerateDraft(
        request,
        response,
        requestId,
        decodeURIComponent(threadDraftMatch[1]),
      );
      return;
    }

    const draftMatch = pathname.match(/^\/v1\/drafts\/([^/]+)$/);
    if (request.method === "PATCH" && draftMatch?.[1]) {
      await handleUpdateDraft(
        request,
        response,
        requestId,
        decodeURIComponent(draftMatch[1]),
      );
      return;
    }

    sendProblem(response, requestId, 404, "Route not found");
  } catch (error) {
    console.error("api: request failed", {
      requestId,
      method: request.method,
      path: pathname,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown API failure",
    });
    if (!response.headersSent) {
      sendProblem(response, requestId, 500, "Internal server error");
    } else {
      response.end();
    }
  }
}

const host = getApiHost();
const port = getApiPort();
const stopAccountSyncNotifications = await listenForAccountSyncNotifications(
  broadcastIndexingNotification,
);
const server = createServer((request, response) => {
  void routeRequest(request, response);
});

server.listen(port, host, () => {
  console.log(`api: listening on http://${host}:${port}`);
});

function shutDown(signal: NodeJS.Signals) {
  console.log(`api: received ${signal}, closing`);
  for (const streams of indexingStreams.values()) {
    for (const response of streams) response.end();
  }
  indexingStreams.clear();
  server.close(async (error) => {
    await stopAccountSyncNotifications();
    if (error) {
      console.error("api: shutdown failed", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));
