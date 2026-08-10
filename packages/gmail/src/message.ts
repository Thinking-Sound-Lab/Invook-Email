import type { GmailMessage, GmailMessagePart } from "./client";

export type ParsedGmailMessage = {
  providerMessageId: string;
  providerThreadId: string;
  labelIds: string[];
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bodyText: string;
  snippet: string;
  sentAt: string;
  attachments: Array<{
    providerAttachmentId: string | null;
    filename: string;
    mimeType: string | null;
    size: number | null;
  }>;
};

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getHeader(part: GmailMessagePart | undefined, name: string): string {
  return (
    part?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function collectTextParts(part: GmailMessagePart | undefined): {
  plain: string[];
  html: string[];
} {
  const result = { plain: [] as string[], html: [] as string[] };
  if (!part) return result;

  if (part.body?.data) {
    if (part.mimeType === "text/plain") result.plain.push(decodeBase64Url(part.body.data));
    if (part.mimeType === "text/html") result.html.push(decodeBase64Url(part.body.data));
  }

  for (const child of part.parts ?? []) {
    const nested = collectTextParts(child);
    result.plain.push(...nested.plain);
    result.html.push(...nested.html);
  }

  return result;
}

function collectAttachments(
  part: GmailMessagePart | undefined,
): ParsedGmailMessage["attachments"] {
  if (!part) return [];

  const filename = part.filename?.trim() ?? "";
  const current = filename
    ? [
        {
          providerAttachmentId: part.body?.attachmentId?.trim() || null,
          filename,
          mimeType: part.mimeType?.trim() || null,
          size:
            typeof part.body?.size === "number" && part.body.size >= 0
              ? part.body.size
              : null,
        },
      ]
    : [];

  return [
    ...current,
    ...(part.parts ?? []).flatMap((child) => collectAttachments(child)),
  ];
}

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function cleanBody(value: string): string {
  const replyBoundary = /\nOn .{1,300}wrote:\s*\n/i;
  const forwardedBoundary = /\n-{2,}\s*Forwarded message\s*-{2,}/i;
  const signatureBoundary = /\n--\s*\n/;
  const boundaries = [replyBoundary, forwardedBoundary, signatureBoundary]
    .map((pattern) => value.search(pattern))
    .filter((index) => index >= 0);
  const ownContent = boundaries.length > 0 ? value.slice(0, Math.min(...boundaries)) : value;

  return ownContent
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseAddressList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function extractEmailAddress(value: string): string {
  const angleAddress = value.match(/<([^>]+)>/);
  return (angleAddress?.[1] ?? value).trim().toLowerCase();
}

export function parseGmailMessage(message: GmailMessage): ParsedGmailMessage {
  const textParts = collectTextParts(message.payload);
  const rawBody = textParts.plain.join("\n\n") || htmlToText(textParts.html.join("\n"));
  const timestamp = Number(message.internalDate);

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    labelIds: message.labelIds ?? [],
    subject: getHeader(message.payload, "Subject"),
    from: getHeader(message.payload, "From"),
    to: parseAddressList(getHeader(message.payload, "To")),
    cc: parseAddressList(getHeader(message.payload, "Cc")),
    bodyText: cleanBody(rawBody),
    snippet: message.snippet ?? "",
    sentAt: Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : new Date(getHeader(message.payload, "Date")).toISOString(),
    attachments: collectAttachments(message.payload),
  };
}

export function isMemoryEligible(message: ParsedGmailMessage): boolean {
  const normalizedSubject = message.subject.toLowerCase();
  const wordCount = message.bodyText.split(/\s+/).filter(Boolean).length;

  return (
    message.labelIds.includes("SENT") &&
    wordCount >= 5 &&
    !normalizedSubject.startsWith("automatic reply") &&
    !normalizedSubject.startsWith("out of office")
  );
}
