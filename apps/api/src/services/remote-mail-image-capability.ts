import { createHmac, timingSafeEqual } from "node:crypto";

import { validate as validateUuid } from "uuid";

const CAPABILITY_LIFETIME_MILLISECONDS = 5 * 60 * 1_000;
const CAPABILITY_VERSION = 1;
const SIGNATURE_CONTEXT = "invook-remote-mail-image:";

interface RemoteMailImageCapabilityPayload {
  expiresAt: number;
  messageId: string;
  userId: string;
  version: typeof CAPABILITY_VERSION;
}

interface RemoteMailImageCapabilityOptions {
  now?: number;
  secret: string;
}

function signPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_CONTEXT}${payload}`)
    .digest();
}

function isCapabilityPayload(
  value: unknown,
): value is RemoteMailImageCapabilityPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.version === CAPABILITY_VERSION &&
    typeof payload.expiresAt === "number" &&
    Number.isSafeInteger(payload.expiresAt) &&
    typeof payload.messageId === "string" &&
    validateUuid(payload.messageId) &&
    typeof payload.userId === "string" &&
    validateUuid(payload.userId)
  );
}

export function createRemoteMailImageCapability(
  input: { messageId: string; userId: string },
  options: RemoteMailImageCapabilityOptions,
): string {
  const now = options.now ?? Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      expiresAt: now + CAPABILITY_LIFETIME_MILLISECONDS,
      messageId: input.messageId,
      userId: input.userId,
      version: CAPABILITY_VERSION,
    } satisfies RemoteMailImageCapabilityPayload),
  ).toString("base64url");
  const signature = signPayload(payload, options.secret).toString("base64url");
  return `${payload}.${signature}`;
}

export function verifyRemoteMailImageCapability(
  capability: string,
  options: RemoteMailImageCapabilityOptions,
): { messageId: string; userId: string } | null {
  const parts = capability.split(".");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return null;
  }
  const [encodedPayload, encodedSignature] = parts;
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = signPayload(encodedPayload, options.secret);
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
  } catch {
    return null;
  }
  if (!isCapabilityPayload(payload)) return null;
  const now = options.now ?? Date.now();
  if (payload.expiresAt <= now) return null;
  return { messageId: payload.messageId, userId: payload.userId };
}
