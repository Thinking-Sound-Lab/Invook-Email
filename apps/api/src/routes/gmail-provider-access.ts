import type { FastifyReply, FastifyRequest } from "fastify";

import { GmailApiError } from "@invook/gmail";

import { sendProblem } from "../responses";
import {
  getGmailProviderAccess,
  getGmailProviderAccessForAccount,
  GmailProviderConfigurationError,
  GmailProviderReconnectRequiredError,
  type GmailProviderAccess,
  type GmailProviderAccessResult,
} from "../services/gmail-provider";

async function resolveGmailProviderAccessForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  loadAccess: () => Promise<GmailProviderAccessResult>,
): Promise<GmailProviderAccess | null> {
  try {
    const result = await loadAccess();
    if (result.status === "not_found") {
      await sendProblem(request, reply, 404, "Connected Gmail account not found");
      return null;
    }
    return result.access;
  } catch (error) {
    if (error instanceof GmailProviderConfigurationError) {
      await sendProblem(request, reply, 503, "Gmail provider writes are not configured");
      return null;
    }
    if (error instanceof GmailProviderReconnectRequiredError) {
      await sendProblem(request, reply, 409, "Gmail account must be reconnected");
      return null;
    }
    if (error instanceof GmailApiError) {
      await sendGmailWriteProblem(error, request, reply);
      return null;
    }
    throw error;
  }
}

export async function getGmailProviderAccessForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GmailProviderAccess | null> {
  const session = request.invookSession;
  if (!session) return null;
  return resolveGmailProviderAccessForRequest(request, reply, () =>
    getGmailProviderAccess(session.userId),
  );
}

export async function getGmailProviderAccessForAccountRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  accountId: string,
): Promise<GmailProviderAccess | null> {
  const session = request.invookSession;
  if (!session) return null;
  return resolveGmailProviderAccessForRequest(request, reply, () =>
    getGmailProviderAccessForAccount({
      userId: session.userId,
      accountId,
    }),
  );
}

export async function sendGmailWriteProblem(
  error: GmailApiError,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (error.status === 400) {
    await sendProblem(request, reply, 400, "Gmail rejected the provider write");
    return;
  }
  if (error.status === 404) {
    await sendProblem(request, reply, 404, "Gmail resource not found");
    return;
  }
  if (error.status === 409) {
    await sendProblem(request, reply, 409, "Gmail provider write conflicted");
    return;
  }
  if (error.status === 0 || error.status === 429 || error.status >= 500) {
    await sendProblem(request, reply, 503, "Gmail provider is unavailable");
    return;
  }
  await sendProblem(request, reply, 502, "Gmail provider write failed");
}
