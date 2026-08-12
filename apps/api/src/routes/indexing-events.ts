import type { FastifyPluginAsync, FastifyReply } from "fastify";

import type { AccountSyncStage, IndexingStatusEvent } from "@invook/contracts";
import {
  getIndexingSyncStateForUser,
  listenForAccountSyncNotifications,
} from "@invook/database";

import { requireSession } from "../access";
import { sendProblem } from "../responses";

const indexingStages = new Set<AccountSyncStage>([
  "pending",
  "running",
  "complete",
  "failed",
]);

function parseNotification(payload: string) {
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

type EventResponse = FastifyReply["raw"];

function writeEvent(response: EventResponse, state: AccountSyncStage) {
  const event: IndexingStatusEvent = { state };
  response.write(`event: indexing\ndata: ${JSON.stringify(event)}\n\n`);
}

export const registerIndexingEventRoutes: FastifyPluginAsync = async (api) => {
  const streams = new Map<string, Set<EventResponse>>();
  const stopListening = process.env.DATABASE_URL
    ? await listenForAccountSyncNotifications((payload) => {
        const notification = parseNotification(payload);
        if (!notification) return;
        for (const response of streams.get(notification.accountId) ?? []) {
          if (!response.destroyed && !response.writableEnded) {
            writeEvent(response, notification.state);
          }
        }
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
      const indexing = await getIndexingSyncStateForUser(session.userId);
      if (!indexing) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }

      reply
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache, no-transform")
        .header("connection", "keep-alive")
        .header("x-accel-buffering", "no");
      reply.hijack();
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
      writeEvent(reply.raw, indexing.state);
    },
  );
};
