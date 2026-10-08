import type {
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import { validate as validateUuid } from "uuid";

import type { InvookSession } from "@invook/auth";

import { createWebHeaders } from "./auth/auth-service";
import { getPublicAppOrigin } from "./config";
import { sendProblem } from "./responses";

/**
 * Resolves the request's session and forwards the cookies Better Auth issued
 * while doing so. Dropping them would leave the browser's cookie cache expired
 * after its first lifetime and return every request to a database lookup.
 */
export async function getRequestSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<InvookSession | null> {
  const { session, setCookies } = await request.server.invookAuth.getSession(
    createWebHeaders(request.headers),
  );
  if (setCookies.length > 0) reply.header("set-cookie", setCookies);
  return session;
}

export const requireSession: onRequestHookHandler = async (request, reply) => {
  const session = await getRequestSession(request, reply);
  if (!session) {
    await sendProblem(request, reply, 401, "Authentication required");
    return;
  }
  request.invookSession = session;
};

const requireAllowedMutationOrigin: onRequestHookHandler = async (
  request,
  reply,
) => {
  const origin = request.headers.origin;
  if (origin && origin !== getPublicAppOrigin()) {
    await sendProblem(request, reply, 403, "Request origin is not allowed");
  }
};

export const mutationAccessHooks: onRequestHookHandler[] = [
  requireSession,
  requireAllowedMutationOrigin,
];

export function requireUuidParameter(
  name: string,
  title: string,
): onRequestHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as Record<string, unknown>;
    const value = params[name];
    if (typeof value !== "string" || !validateUuid(value)) {
      await sendProblem(request, reply, 400, title);
    }
  };
}

export function isUuid(value: string): boolean {
  return validateUuid(value);
}
