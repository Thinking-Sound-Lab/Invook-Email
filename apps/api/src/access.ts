import type {
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from "fastify";
import { validate as validateUuid } from "uuid";

import { createWebHeaders } from "./auth/auth-service";
import { getPublicAppOrigin } from "./config";
import { sendProblem } from "./responses";

export const requireSession: onRequestHookHandler = async (request, reply) => {
  const session = await request.server.invookAuth.getSession(
    createWebHeaders(request.headers),
  );
  if (!session) {
    await sendProblem(request, reply, 401, "Authentication required");
    return;
  }
  request.invookSession = session;
};

export const requireAllowedMutationOrigin: onRequestHookHandler = async (
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
