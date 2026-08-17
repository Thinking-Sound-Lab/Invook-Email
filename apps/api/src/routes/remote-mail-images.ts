import type { FastifyPluginAsync } from "fastify";

import type { RemoteMailImageCapabilityResponse } from "@invook/contracts";
import { getMailboxMessageBodyForUser } from "@invook/database";
import {
  extractRemoteMailImageUrls,
  getCachedRemoteMailImage,
  normalizeRemoteMailImageUrl,
  RemoteMailImageCacheUnavailableError,
  type RemoteMailImage,
} from "@invook/mail-content";

import { requireSession, requireUuidParameter } from "../access";
import { sendProblem } from "../responses";
import {
  createRemoteMailImageCapability,
  verifyRemoteMailImageCapability,
} from "../services/remote-mail-image-capability";

const MAXIMUM_SOURCE_LENGTH = 8_192;
const MAXIMUM_CAPABILITY_LENGTH = 2_048;

export interface RemoteMailImageRouteDependencies {
  capabilitySecret?: string;
  getMessageBody?: (input: {
    userId: string;
    messageId: string;
  }) => Promise<{ bodyHtml: string | null } | null>;
  getImage?: (source: string) => Promise<RemoteMailImage | null>;
}

export function registerRemoteMailImageRoutes(
  dependencies: RemoteMailImageRouteDependencies = {},
): FastifyPluginAsync {
  const getMessageBody =
    dependencies.getMessageBody ?? getMailboxMessageBodyForUser;
  const getImage = dependencies.getImage ?? getCachedRemoteMailImage;
  const capabilitySecret =
    dependencies.capabilitySecret ?? process.env.BETTER_AUTH_SECRET?.trim() ?? "";

  return async (api) => {
    api.get<{ Params: { messageId: string } }>(
      "/v1/messages/:messageId/remote-image-capability",
      {
        onRequest: [
          requireSession,
          requireUuidParameter("messageId", "Invalid message ID"),
        ],
      },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const message = await getMessageBody({
          userId: session.userId,
          messageId: request.params.messageId,
        });
        if (!message?.bodyHtml) {
          await sendProblem(request, reply, 404, "Message content not found");
          return;
        }
        if (!capabilitySecret) {
          await sendProblem(
            request,
            reply,
            503,
            "Remote image proxy is not configured",
          );
          return;
        }

        const response: RemoteMailImageCapabilityResponse = {
          capability: createRemoteMailImageCapability(
            {
              messageId: request.params.messageId,
              userId: session.userId,
            },
            { secret: capabilitySecret },
          ),
        };
        reply.header("cache-control", "no-store");
        await reply.send(response);
      },
    );

    api.get<{
      Params: { messageId: string };
      Querystring: { capability?: unknown; source?: unknown };
    }>(
      "/v1/messages/:messageId/remote-image",
      {
        onRequest: [requireUuidParameter("messageId", "Invalid message ID")],
      },
      async (request, reply) => {
        const requestedCapability = request.query.capability;
        if (
          typeof requestedCapability !== "string" ||
          requestedCapability.length === 0 ||
          requestedCapability.length > MAXIMUM_CAPABILITY_LENGTH ||
          !capabilitySecret
        ) {
          await sendProblem(request, reply, 404, "Remote image not found");
          return;
        }
        const authorization = verifyRemoteMailImageCapability(
          requestedCapability,
          { secret: capabilitySecret },
        );
        if (
          !authorization ||
          authorization.messageId !== request.params.messageId
        ) {
          await sendProblem(request, reply, 404, "Remote image not found");
          return;
        }
        const requestedSource = request.query.source;
        if (
          typeof requestedSource !== "string" ||
          requestedSource.length === 0 ||
          requestedSource.length > MAXIMUM_SOURCE_LENGTH
        ) {
          await sendProblem(request, reply, 400, "Invalid remote image source");
          return;
        }
        const source = normalizeRemoteMailImageUrl(requestedSource);
        if (!source) {
          await sendProblem(request, reply, 400, "Invalid remote image source");
          return;
        }

        const message = await getMessageBody({
          userId: authorization.userId,
          messageId: request.params.messageId,
        });
        if (
          !message?.bodyHtml ||
          !extractRemoteMailImageUrls(message.bodyHtml).has(source)
        ) {
          await sendProblem(request, reply, 404, "Remote image not found");
          return;
        }

        let image: RemoteMailImage | null;
        try {
          image = await getImage(source);
        } catch (error) {
          if (error instanceof RemoteMailImageCacheUnavailableError) {
            await sendProblem(
              request,
              reply,
              503,
              "Remote image cache is unavailable",
            );
            return;
          }
          throw error;
        }
        if (!image) {
          await sendProblem(request, reply, 404, "Remote image not available");
          return;
        }

        reply
          .type(image.contentType)
          .header("cache-control", "private, max-age=31536000, immutable")
          .header("content-length", String(image.bytes.byteLength))
          .header("cross-origin-resource-policy", "cross-origin");
        await reply.send(image.bytes);
      },
    );
  };
}
