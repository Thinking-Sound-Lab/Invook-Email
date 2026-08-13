import type { FastifyReply, FastifyRequest } from "fastify";

import { GmailApiError } from "@invook/gmail";

import { sendProblem } from "../responses";
import {
  getGmailProviderAccess,
  GmailProviderConfigurationError,
  GmailProviderReconnectRequiredError,
  type GmailProviderAccess,
} from "../services/gmail-provider";

export async function getGmailProviderAccessForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GmailProviderAccess | null> {
  const session = request.invookSession;
  if (!session) return null;
  try {
    const result = await getGmailProviderAccess(session.userId);
    if (result.status === "not_found") {
      await sendProblem(request, reply, 404, "Connected Gmail account not found");
      return null;
    }
    if (result.status === "replica_not_ready") {
      await sendProblem(request, reply, 409, "Gmail mailbox replica is not ready");
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
