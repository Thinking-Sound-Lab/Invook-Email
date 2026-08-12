import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { v4 as uuidv4 } from "uuid";

import { registerAuthRoutes } from "./routes/auth";
import { registerAgentRoutes } from "./routes/agent";
import { registerBatchWebhookRoutes } from "./routes/batch-webhook";
import { registerDraftRoutes } from "./routes/drafts";
import { registerHealthRoutes } from "./routes/health";
import { registerIndexingEventRoutes } from "./routes/indexing-events";
import { registerLabelRoutes } from "./routes/labels";
import { registerMailboxRoutes } from "./routes/mailbox";
import { registerMemoryRoutes } from "./routes/memories";
import { registerSessionRoutes } from "./routes/session";
import { registerThreadLabelRoutes } from "./routes/thread-labels";
import { InvalidJsonBodyError, sendProblem } from "./responses";

const MAXIMUM_REQUEST_BODY_BYTES = 65_536;

function isInvalidBodyError(error: unknown): boolean {
  return (
    error instanceof InvalidJsonBodyError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
  );
}

export async function buildApi() {
  const api = Fastify({
    bodyLimit: MAXIMUM_REQUEST_BODY_BYTES,
    exposeHeadRoutes: false,
    genReqId: () => uuidv4(),
    logger: false,
    requestIdHeader: "x-request-id",
    routerOptions: {
      caseSensitive: true,
      ignoreTrailingSlash: true,
    },
  });

  api.decorateRequest("invookSession", null);
  await api.register(fastifyCookie);

  api.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", request.id);
  });

  api.removeAllContentTypeParsers();
  api.addContentTypeParser(
    "*",
    { parseAs: "string" },
    async (_request: FastifyRequest, body: string) => {
      if (!body) return null;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new InvalidJsonBodyError();
      }
    },
  );

  await api.register(registerBatchWebhookRoutes, { prefix: "/v1/webhooks" });
  await api.register(registerHealthRoutes);
  await api.register(registerAuthRoutes);
  await api.register(registerSessionRoutes);
  await api.register(registerAgentRoutes);
  await api.register(registerIndexingEventRoutes);
  await api.register(registerMailboxRoutes);
  await api.register(registerMemoryRoutes, { prefix: "/v1/memories" });
  await api.register(registerLabelRoutes, { prefix: "/v1/labels" });
  await api.register(registerThreadLabelRoutes, { prefix: "/v1/threads" });
  await api.register(registerDraftRoutes);

  api.setNotFoundHandler(async (request, reply) => {
    await sendProblem(request, reply, 404, "Route not found");
  });

  api.setErrorHandler(async (error, request, reply) => {
    if (isInvalidBodyError(error)) {
      await sendProblem(request, reply, 400, "Invalid JSON request body");
      return;
    }

    const normalizedError =
      error instanceof Error ? error : new Error("Unknown API failure");
    console.error("api: request failed", {
      requestId: request.id,
      method: request.method,
      path: request.url.split("?", 1)[0],
      name: normalizedError.name,
      message: normalizedError.message,
    });
    if (!reply.raw.headersSent) {
      await sendProblem(request, reply, 500, "Internal server error");
      return;
    }
    reply.raw.end();
  });

  return api;
}
