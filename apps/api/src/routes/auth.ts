import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  decryptGoogleCredential,
  encryptGoogleCredential,
  getGmailConnectionForOAuth,
  saveGmailConnection,
} from "@invook/database";
import {
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  getGmailProfile,
  GmailApiError,
  startGmailWatch,
} from "@invook/gmail";

import {
  clearOAuthRequestCookies,
  createOAuthRequestCookies,
  createOAuthState,
  getInvookUserId,
  isMatchingOAuthState,
  readOAuthRequest,
} from "../auth/oauth-state";
import { clearSessionCookie, createSessionCookie } from "../auth/session";
import {
  getMissingGmailConnectionConfiguration,
  getPublicAppOrigin,
} from "../config";
import { sendRedirect } from "../responses";

type ConnectionErrorReason =
  | "authorization"
  | "configuration"
  | "gmail_access"
  | "offline_access"
  | "unknown";

type CallbackQuery = {
  error?: unknown;
  code?: unknown;
  state?: unknown;
};

function connectionErrorUrl(reason: ConnectionErrorReason): string {
  const target = new URL("/auth/error", getPublicAppOrigin());
  target.searchParams.set("reason", reason);
  return target.toString();
}

async function handleGoogleStart(reply: FastifyReply) {
  if (getMissingGmailConnectionConfiguration().length > 0) {
    await sendRedirect(reply, connectionErrorUrl("configuration"), 302);
    return;
  }

  const state = createOAuthState();
  const authorization = await createGoogleAuthorizationRequest({
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: `${getPublicAppOrigin()}/auth/callback`,
    state,
  });
  createOAuthRequestCookies(reply, state, authorization.codeVerifier);
  await sendRedirect(reply, authorization.url, 302);
}

async function handleGoogleCallback(
  request: FastifyRequest<{ Querystring: CallbackQuery }>,
  reply: FastifyReply,
) {
  const providerError =
    typeof request.query.error === "string" ? request.query.error : null;
  const code = typeof request.query.code === "string" ? request.query.code : null;
  const returnedState =
    typeof request.query.state === "string" ? request.query.state : null;
  const oauthRequest = readOAuthRequest(request);

  if (
    providerError ||
    !code ||
    !oauthRequest.codeVerifier ||
    !isMatchingOAuthState(oauthRequest.state, returnedState)
  ) {
    clearOAuthRequestCookies(reply);
    await sendRedirect(reply, connectionErrorUrl("authorization"), 302);
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
    const topicName = process.env.GMAIL_PUBSUB_TOPIC;
    if (!topicName) {
      throw new Error("GMAIL_PUBSUB_TOPIC is required to connect Gmail.");
    }
    const watch = await startGmailWatch(authorization.accessToken, {
      topicName,
    });
    const watchExpiration = Number(watch.expiration);
    if (!Number.isFinite(watchExpiration)) {
      throw new Error("Gmail returned an invalid watch expiration.");
    }
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
      clearOAuthRequestCookies(reply);
      await sendRedirect(reply, connectionErrorUrl("offline_access"), 302);
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
      initialHistoryId: gmailProfile.historyId,
      watch: {
        topicName,
        historyId: watch.historyId,
        expirationAt: new Date(watchExpiration),
      },
      tokenCiphertext,
      acknowledgedAt,
    });

    clearOAuthRequestCookies(reply);
    createSessionCookie(reply, { userId, googleSubject: providerAccountId });
    await sendRedirect(
      reply,
      new URL("/mail", getPublicAppOrigin()).toString(),
      302,
    );
  } catch (error) {
    console.error("api: gmail oauth callback failed", {
      requestId: request.id,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown callback failure",
      status: error instanceof GmailApiError ? error.status : undefined,
    });
    clearOAuthRequestCookies(reply);
    await sendRedirect(
      reply,
      connectionErrorUrl(
        error instanceof GmailApiError && error.status === 403
          ? "gmail_access"
          : "unknown",
      ),
      302,
    );
  }
}

export const registerAuthRoutes: FastifyPluginAsync = async (api) => {
  api.get("/v1/auth/google/start", async (_request, reply) => {
    await handleGoogleStart(reply);
  });

  api.get<{ Querystring: CallbackQuery }>(
    "/v1/auth/google/callback",
    async (request, reply) => {
      await handleGoogleCallback(request, reply);
    },
  );

  api.post("/v1/auth/sign-out", async (_request, reply) => {
    clearSessionCookie(reply);
    await sendRedirect(reply, new URL("/", getPublicAppOrigin()).toString(), 303);
  });
};
