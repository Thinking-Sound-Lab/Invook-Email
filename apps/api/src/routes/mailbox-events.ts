import type { FastifyPluginAsync, FastifyReply } from "fastify";

import type { MailboxChangeEvent } from "@invook/contracts";
import {
  getMailboxChangeEvent,
  getMailboxChangeEventsForUser,
  listenForMailboxChangeNotifications,
} from "@invook/database";

import { isUuid, requireSession } from "../access";
import { sendProblem } from "../responses";

type StoredMailboxChangeEvent = Awaited<
  ReturnType<typeof getMailboxChangeEventsForUser>
>[number];

type EventResponse = FastifyReply["raw"];

type MailboxEventStream = {
  delivered: Set<string>;
  pending: Map<string, StoredMailboxChangeEvent>;
  replaying: boolean;
  response: EventResponse;
};

function writeEvent(response: EventResponse, event: StoredMailboxChangeEvent) {
  const payload: MailboxChangeEvent = {
    id: event.id,
    accountId: event.accountId,
    changeType: event.changeType,
    createdAt: event.createdAt.toISOString(),
  };
  response.write(
    `id: ${event.id}\nevent: mailbox\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

function isOpen(stream: MailboxEventStream) {
  return !stream.response.destroyed && !stream.response.writableEnded;
}

function deliver(stream: MailboxEventStream, event: StoredMailboxChangeEvent) {
  if (!isOpen(stream) || stream.delivered.has(event.id)) return;
  if (stream.replaying) {
    stream.pending.set(event.id, event);
    return;
  }
  writeEvent(stream.response, event);
}

function compareEvents(left: StoredMailboxChangeEvent, right: StoredMailboxChangeEvent) {
  const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
  return createdAtDifference || left.id.localeCompare(right.id);
}

export const registerMailboxEventRoutes: FastifyPluginAsync = async (api) => {
  const streams = new Map<string, Set<MailboxEventStream>>();
  let delivery = Promise.resolve();
  const stopListening = process.env.DATABASE_URL
    ? await listenForMailboxChangeNotifications((eventId) => {
        delivery = delivery
          .then(async () => {
            const event = await getMailboxChangeEvent(eventId);
            if (!event) return;
            for (const stream of streams.get(event.userId) ?? []) {
              deliver(stream, event);
            }
          })
          .catch((error: unknown) => {
            const normalizedError =
              error instanceof Error ? error : new Error("Unknown mailbox event failure");
            api.log.error(
              { name: normalizedError.name, message: normalizedError.message },
              "mailbox event delivery failed",
            );
          });
      })
    : null;

  api.addHook("onClose", async () => {
    for (const userStreams of streams.values()) {
      for (const stream of userStreams) stream.response.end();
    }
    streams.clear();
    await stopListening?.();
    await delivery;
  });

  api.get(
    "/v1/mailbox/events",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;

      const lastEventHeader = request.headers["last-event-id"];
      const lastEventId = Array.isArray(lastEventHeader)
        ? lastEventHeader[0]
        : lastEventHeader;
      if (lastEventId && !isUuid(lastEventId)) {
        await sendProblem(request, reply, 400, "Last mailbox event ID is invalid");
        return;
      }
      if (lastEventId) {
        const lastEvent = await getMailboxChangeEvent(lastEventId);
        if (!lastEvent || lastEvent.userId !== session.userId) {
          await sendProblem(request, reply, 400, "Last mailbox event ID is invalid");
          return;
        }
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

      const stream: MailboxEventStream = {
        delivered: new Set(),
        pending: new Map(),
        replaying: Boolean(lastEventId),
        response: reply.raw,
      };
      const userStreams = streams.get(session.userId) ?? new Set();
      userStreams.add(stream);
      streams.set(session.userId, userStreams);

      const removeStream = () => {
        userStreams.delete(stream);
        if (userStreams.size === 0) streams.delete(session.userId);
      };
      request.raw.once("close", removeStream);
      reply.raw.once("close", removeStream);

      reply.raw.write(": connected\n\n");

      if (!lastEventId) return;

      try {
        let cursor: string | null = lastEventId;
        while (cursor) {
          const events = await getMailboxChangeEventsForUser({
            userId: session.userId,
            afterEventId: cursor,
            limit: 100,
          });
          for (const event of events) {
            if (!isOpen(stream)) return;
            writeEvent(stream.response, event);
            stream.delivered.add(event.id);
          }
          cursor = events.length === 100 ? events.at(-1)?.id ?? null : null;
        }

        for (const event of [...stream.pending.values()].sort(compareEvents)) {
          if (!isOpen(stream)) return;
          if (!stream.delivered.has(event.id)) {
            writeEvent(stream.response, event);
            stream.delivered.add(event.id);
          }
        }
        stream.pending.clear();
        stream.replaying = false;
      } catch (error) {
        request.log.error(error, "mailbox event replay failed");
        removeStream();
        reply.raw.end();
      }
    },
  );
};
