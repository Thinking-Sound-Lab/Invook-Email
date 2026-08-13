import type { FastifyPluginAsync, FastifyReply } from "fastify";

import type { IndexingProgress, IndexingStatusEvent } from "@invook/contracts";
import {
  getIndexingProgressForAccount,
  getIndexingProgressForUser,
  listenForAccountSyncNotifications,
  MAIL_INDEX_VERSION,
} from "@invook/database";

import { requireSession } from "../access";
import { sendProblem } from "../responses";

function parseNotification(payload: string) {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return typeof value.accountId === "string" ? value.accountId : null;
  } catch {
    return null;
  }
}

type EventResponse = FastifyReply["raw"];

function writeEvent(response: EventResponse, progress: IndexingProgress) {
  const event: IndexingStatusEvent = progress;
  response.write(`event: indexing\ndata: ${JSON.stringify(event)}\n\n`);
}

export const registerIndexingEventRoutes: FastifyPluginAsync = async (api) => {
  const streams = new Map<string, Set<EventResponse>>();
  const modelId = process.env.OPENAI_EMBEDDING_MODEL?.trim() || null;
  const broadcastDurableProgress = async (accountId: string) => {
    const progress = await getIndexingProgressForAccount({
      accountId,
      modelId,
      indexVersion: MAIL_INDEX_VERSION,
    });
    if (!progress) return;
    for (const response of streams.get(accountId) ?? []) {
      if (!response.destroyed && !response.writableEnded) {
        writeEvent(response, progress);
      }
    }
  };
  const stopListening = process.env.DATABASE_URL
    ? await listenForAccountSyncNotifications((payload) => {
        const accountId = parseNotification(payload);
        if (!accountId) return;
        void broadcastDurableProgress(accountId).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("api: indexing progress notification failed", {
            accountId,
            message,
          });
        });
      })
    : null;

  api.addHook("onClose", async () => {
    for (const accountStreams of streams.values()) {
      for (const response of accountStreams) response.end();
    }
    streams.clear();
    await stopListening?.();
  });

  api.get(
    "/v1/indexing/events",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const indexing = await getIndexingProgressForUser({
        userId: session.userId,
        modelId,
        indexVersion: MAIL_INDEX_VERSION,
      });
      if (!indexing) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }

      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache, no-transform");
      reply.raw.setHeader("connection", "keep-alive");
      reply.raw.setHeader("x-accel-buffering", "no");
      reply.raw.setHeader("x-content-type-options", "nosniff");
      reply.raw.setHeader("x-request-id", request.id);
      reply.raw.flushHeaders();

      const accountStreams = streams.get(indexing.accountId) ?? new Set();
      accountStreams.add(reply.raw);
      streams.set(indexing.accountId, accountStreams);
      const removeStream = () => {
        accountStreams.delete(reply.raw);
        if (accountStreams.size === 0) streams.delete(indexing.accountId);
      };
      request.raw.once("close", removeStream);
      reply.raw.once("close", removeStream);
      writeEvent(reply.raw, indexing.progress);
    },
  );
};
