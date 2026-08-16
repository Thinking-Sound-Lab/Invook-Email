import type { FastifyPluginAsync } from "fastify";
import { Parser } from "htmlparser2";
import valueParser from "postcss-value-parser";

import type { RemoteMailImageCapabilityResponse } from "@invook/contracts";
import { getMailboxMessageBodyForUser } from "@invook/database";

import { requireSession, requireUuidParameter } from "../access";
import { sendProblem } from "../responses";
import {
  createRemoteMailImageCapability,
  verifyRemoteMailImageCapability,
} from "../services/remote-mail-image-capability";
import {
  normalizeRemoteMailImageUrl,
  RemoteMailImageUnavailableError,
  type RemoteMailImage,
  UnsafeRemoteMailImageUrlError,
} from "../services/remote-mail-image";
import {
  getRemoteMailImage,
  RemoteMailImageCacheUnavailableError,
} from "../services/remote-mail-image-cache";

const MAXIMUM_SOURCE_LENGTH = 8_192;
const MAXIMUM_CAPABILITY_LENGTH = 2_048;

export interface RemoteMailImageRouteDependencies {
  capabilitySecret?: string;
  getMessageBody?: (input: {
    userId: string;
    messageId: string;
  }) => Promise<{ bodyHtml: string | null } | null>;
  getImage?: (source: string) => Promise<RemoteMailImage>;
}

function unquoteCssUrl(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function collectCssImageUrls(css: string, sources: Set<string>): void {
  const parsed = valueParser(css);
  parsed.walk((node) => {
    if (
      node.type === "function" &&
      ["image-set", "-webkit-image-set"].includes(node.value.toLowerCase())
    ) {
      for (const imageSetNode of node.nodes) {
        if (imageSetNode.type !== "string") continue;
        const source = normalizeRemoteMailImageUrl(imageSetNode.value);
        if (source) sources.add(source);
      }
      return undefined;
    }
    if (node.type !== "function" || node.value.toLowerCase() !== "url") {
      return undefined;
    }
    const source = normalizeRemoteMailImageUrl(
      unquoteCssUrl(valueParser.stringify(node.nodes)),
    );
    if (source) sources.add(source);
    return false;
  });
}

export function extractRemoteMailImageUrls(bodyHtml: string): Set<string> {
  const sources = new Set<string>();
  let styleDepth = 0;
  const parser = new Parser(
    {
      onopentag: (name, attributes) => {
        if (name === "style") styleDepth += 1;
        if (attributes.style) collectCssImageUrls(attributes.style, sources);
        if (name !== "img") return;
        const source = normalizeRemoteMailImageUrl(attributes.src ?? "");
        if (source) sources.add(source);
      },
      ontext: (text) => {
        if (styleDepth > 0) collectCssImageUrls(text, sources);
      },
      onclosetag: (name) => {
        if (name === "style") styleDepth = Math.max(0, styleDepth - 1);
      },
    },
    { decodeEntities: true },
  );
  parser.end(bodyHtml);
  return sources;
}

export function registerRemoteMailImageRoutes(
  dependencies: RemoteMailImageRouteDependencies = {},
): FastifyPluginAsync {
  const getMessageBody =
    dependencies.getMessageBody ?? getMailboxMessageBodyForUser;
  const getImage = dependencies.getImage ?? getRemoteMailImage;
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

        let image: RemoteMailImage;
        try {
          image = await getImage(source);
        } catch (error) {
          if (error instanceof UnsafeRemoteMailImageUrlError) {
            await sendProblem(request, reply, 404, "Remote image not found");
            return;
          }
          if (error instanceof RemoteMailImageUnavailableError) {
            await sendProblem(request, reply, 502, "Remote image is unavailable");
            return;
          }
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
