import { createHash } from "node:crypto";

import {
  simpleParser,
  type AddressObject,
  type EmailAddress,
  type HeaderLines,
  type Headers,
  type HeaderValue,
} from "mailparser";

import type { GmailRawMessage } from "./client";
import {
  filterGmailSystemLabelIds,
  type GmailSystemLabelId,
} from "./system-labels";

export type ParsedGmailHeader = {
  /** Lowercase field name as interpreted by the MIME parser. */
  name: string;
  /** The complete unfolded field value, including encoded words where present. */
  value: string;
  /** The complete header line supplied by the MIME parser. */
  raw: string;
};

export type ParsedGmailAttachment = {
  index: number;
  mimePartPath: string | null;
  filename: string | null;
  mimeType: string;
  contentDisposition: string | null;
  contentId: string | null;
  cid: string | null;
  related: boolean;
  size: number;
  checksumSha256: string;
  headers: ParsedGmailHeader[];
  content: Buffer;
};

export type ParsedGmailMessage = {
  providerMessageId: string;
  providerThreadId: string;
  historyId: string | null;
  internalDate: string | null;
  sizeEstimate: number | null;
  labelIds: GmailSystemLabelId[];
  snippet: string;
  raw: Buffer;
  rawSize: number;
  rawChecksumSha256: string;
  headers: ParsedGmailHeader[];
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: string | null;
  attachments: ParsedGmailAttachment[];
};

export const GMAIL_MESSAGE_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1_000;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function headerValueText(value: HeaderValue): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(headerValueText).join(", ");
  if ("text" in value) return value.text;
  return [
    value.value,
    ...Object.entries(value.params).map(([key, parameter]) => `${key}=${parameter}`),
  ].join("; ");
}

function parseHeaders(
  lines: HeaderLines | undefined,
  fallback?: Headers,
): ParsedGmailHeader[] {
  if (!lines) {
    return [...(fallback ?? new Map())].map(([name, value]) => {
      const text = headerValueText(value);
      return { name, value: text, raw: `${name}: ${text}` };
    });
  }
  return lines.map(({ key, line }) => {
    const separator = line.indexOf(":");
    return {
      name: key.toLowerCase(),
      value: separator >= 0 ? line.slice(separator + 1).trimStart() : "",
      raw: line,
    };
  });
}

function addressText(value: EmailAddress): string[] {
  if (value.group) return value.group.flatMap(addressText);
  if (value.address && value.name) return [`${value.name} <${value.address}>`];
  if (value.address) return [value.address];
  return value.name ? [value.name] : [];
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    entry.value.flatMap(addressText),
  );
}

function firstAddress(value: AddressObject | undefined): string {
  return value?.text ?? "";
}

function validIsoDate(
  value: Date | number | undefined,
  latestAllowedAt: number,
): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && timestamp <= latestAllowedAt
    ? date.toISOString()
    : null;
}

function receivedHeaderDate(
  headers: ParsedGmailHeader[],
  latestAllowedAt: number,
): string | null {
  const receivedHeaders = headers.filter(
    (header) => header.name === "received" || header.name === "x-received",
  );
  for (const header of receivedHeaders) {
    const separator = header.raw.lastIndexOf(";");
    if (separator < 0) continue;
    const receivedAt = validIsoDate(
      new Date(header.raw.slice(separator + 1).trim()),
      latestAllowedAt,
    );
    if (receivedAt) return receivedAt;
  }
  return null;
}

export function resolveGmailMessageDate(input: {
  internalDate?: string | null;
  headerDate?: Date;
  headers: ParsedGmailHeader[];
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(nowTimestamp)) {
    throw new Error("The Gmail message date reference is invalid.");
  }
  const latestAllowedAt = nowTimestamp + GMAIL_MESSAGE_FUTURE_TOLERANCE_MS;
  const internalDate = input.internalDate;
  if (internalDate && /^\d+$/.test(internalDate)) {
    const date = validIsoDate(Number(internalDate), latestAllowedAt);
    if (date) return date;
  }
  return (
    receivedHeaderDate(input.headers, latestAllowedAt) ??
    validIsoDate(input.headerDate, latestAllowedAt)
  );
}

function referenceList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function extractEmailAddress(value: string): string {
  const angleAddress = value.match(/<([^>]+)>/);
  return (angleAddress?.[1] ?? value).trim().toLowerCase();
}

/**
 * Decodes Gmail's raw base64url message and parses the complete RFC 2822/MIME
 * object. No quoted reply, signature, header, HTML, or attachment data is
 * deliberately removed.
 */
export async function parseGmailMessage(
  message: GmailRawMessage,
): Promise<ParsedGmailMessage> {
  if (!message.raw) {
    throw new Error(`Gmail message ${message.id} did not include raw MIME data.`);
  }

  const raw = Buffer.from(message.raw, "base64url");
  const parsed = await simpleParser(raw, {
    keepCidLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const headers = parseHeaders(parsed.headerLines);

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    historyId: message.historyId ?? null,
    internalDate: message.internalDate ?? null,
    sizeEstimate:
      typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
    labelIds: filterGmailSystemLabelIds(message.labelIds),
    snippet: message.snippet ?? "",
    raw,
    rawSize: raw.byteLength,
    rawChecksumSha256: sha256(raw),
    headers,
    subject: parsed.subject ?? "",
    from: firstAddress(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    replyTo: parsed.replyTo?.text ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: referenceList(parsed.references),
    bodyText: parsed.text ?? null,
    bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
    sentAt: resolveGmailMessageDate({
      internalDate: message.internalDate,
      headerDate: parsed.date,
      headers,
    }),
    attachments: parsed.attachments.map((attachment, index) => {
      const mimePart = attachment as typeof attachment & { partId?: string };
      return {
        index,
        mimePartPath: mimePart.partId ?? null,
        filename: attachment.filename ?? null,
        mimeType: attachment.contentType,
        contentDisposition: attachment.contentDisposition || null,
        contentId: attachment.contentId ?? null,
        cid: attachment.cid ?? null,
        related: attachment.related === true,
        size: attachment.size,
        checksumSha256: sha256(attachment.content),
        headers: parseHeaders(attachment.headerLines, attachment.headers),
        content: attachment.content,
      };
    }),
  };
}

export function isMemoryEligible(message: ParsedGmailMessage): boolean {
  const normalizedSubject = message.subject.toLowerCase();
  const wordCount = (message.bodyText ?? "").split(/\s+/).filter(Boolean).length;

  return (
    message.labelIds.includes("SENT") &&
    wordCount >= 5 &&
    !normalizedSubject.startsWith("automatic reply") &&
    !normalizedSubject.startsWith("out of office")
  );
}
