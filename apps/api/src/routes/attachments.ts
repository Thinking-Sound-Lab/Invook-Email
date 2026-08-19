import { createHash } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import {
  getMailboxAttachmentDownloadForUser,
  type MailboxAttachmentDownload,
} from "@invook/database";
import {
  createObjectStorage,
  ObjectStorageObjectNotFoundError,
} from "@invook/object-storage";

import { requireSession, requireUuidParameter } from "../access";
import { sendProblem } from "../responses";

export type AttachmentRouteDependencies = {
  getAttachment?: (input: {
    userId: string;
    attachmentId: string;
  }) => Promise<MailboxAttachmentDownload | null>;
  readObject?: (objectKey: string) => Promise<Buffer>;
};

class AttachmentIntegrityError extends Error {}

const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const ACTIVE_MIME_TYPES = new Set([
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
]);

function safeAttachmentContentType(mimeType: string | null): string {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  return MIME_TYPE_PATTERN.test(normalized) && !ACTIVE_MIME_TYPES.has(normalized)
    ? normalized
    : "application/octet-stream";
}

function encodedFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function replaceUnpairedSurrogates(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

function attachmentContentDisposition(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1) ?? "";
  const safeUnicode = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const normalized = replaceUnpairedSurrogates(safeUnicode || "attachment");
  const asciiFallback = normalized
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename(normalized)}`;
}

function attachmentEtag(attachment: MailboxAttachmentDownload): string | null {
  const checksum = attachment.checksumSha256?.trim().toLowerCase();
  if (checksum && /^[a-f\d]{64}$/.test(checksum)) return `"${checksum}"`;
  const etag = attachment.etag?.trim().replace(/^"|"$/g, "");
  return etag && /^[a-z\d._:-]+$/i.test(etag) ? `"${etag}"` : null;
}

function requestMatchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

export function registerAttachmentRoutes(
  dependencies: AttachmentRouteDependencies = {},
): FastifyPluginAsync {
  const getAttachment =
    dependencies.getAttachment ?? getMailboxAttachmentDownloadForUser;
  const readObject =
    dependencies.readObject ??
    ((objectKey: string) => createObjectStorage().getObject(objectKey));

  return async (api) => {
    api.get<{ Params: { id: string } }>(
      "/v1/attachments/:id/download",
      {
        onRequest: [
          requireSession,
          requireUuidParameter("id", "Invalid attachment ID"),
        ],
      },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const attachment = await getAttachment({
          userId: session.userId,
          attachmentId: request.params.id,
        });
        if (!attachment) {
          await sendProblem(request, reply, 404, "Attachment not found");
          return;
        }

        const etag = attachmentEtag(attachment);
        reply.header("cache-control", "private, no-cache");
        if (etag) reply.header("etag", etag);
        if (etag && requestMatchesEtag(request.headers["if-none-match"], etag)) {
          await reply.code(304).send();
          return;
        }
        if (!attachment.objectKey) {
          await sendProblem(request, reply, 404, "Stored attachment not found");
          return;
        }

        let bytes: Buffer;
        try {
          bytes = await readObject(attachment.objectKey);
          if (
            attachment.contentLength !== null &&
            attachment.contentLength !== bytes.byteLength
          ) {
            throw new AttachmentIntegrityError();
          }
          const checksum = attachment.checksumSha256?.trim().toLowerCase();
          if (
            checksum &&
            /^[a-f\d]{64}$/.test(checksum) &&
            createHash("sha256").update(bytes).digest("hex") !== checksum
          ) {
            throw new AttachmentIntegrityError();
          }
        } catch (error) {
          if (error instanceof ObjectStorageObjectNotFoundError) {
            await sendProblem(request, reply, 404, "Stored attachment not found");
            return;
          }
          if (error instanceof AttachmentIntegrityError) {
            await sendProblem(request, reply, 502, "Stored attachment failed integrity checks");
            return;
          }
          await sendProblem(request, reply, 503, "Attachment storage is unavailable");
          return;
        }

        reply
          .type(safeAttachmentContentType(attachment.mimeType))
          .header("content-disposition", attachmentContentDisposition(attachment.filename))
          .header("content-length", String(bytes.byteLength));
        await reply.send(bytes);
      },
    );
  };
}
