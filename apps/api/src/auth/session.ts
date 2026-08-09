import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { usesSecureCookies } from "../config";
import { readCookies, serializeCookie } from "../http/cookies";

const SESSION_COOKIE = "invook_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30;

export type InvookSession = {
  userId: string;
  googleSubject: string;
  expiresAt: number;
};

type SerializedSession = InvookSession & { version: 1 };

function parseRootKey(): Buffer {
  const value = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 32-byte value.");
  }
  return key;
}

function getSessionSigningKey(): Buffer {
  return createHmac("sha256", parseRootKey())
    .update("invook:session-signing:v1")
    .digest();
}

function sign(value: string): string {
  return createHmac("sha256", getSessionSigningKey())
    .update(value)
    .digest("base64url");
}

function serializeSession(session: InvookSession): string {
  const payload = Buffer.from(
    JSON.stringify({ ...session, version: 1 } satisfies SerializedSession),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function parseSession(value: string | undefined): InvookSession | null {
  if (!value) return null;

  const [payload, suppliedSignature] = value.split(".");
  if (!payload || !suppliedSignature) return null;

  const expectedSignature = Buffer.from(sign(payload), "base64url");
  const actualSignature = Buffer.from(suppliedSignature, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SerializedSession>;
    if (
      parsed.version !== 1 ||
      typeof parsed.userId !== "string" ||
      typeof parsed.googleSubject !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now()
    ) {
      return null;
    }

    return {
      userId: parsed.userId,
      googleSubject: parsed.googleSubject,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: usesSecureCookies(),
    path: "/",
  };
}

export function getCurrentSession(request: IncomingMessage): InvookSession | null {
  return parseSession(readCookies(request).get(SESSION_COOKIE));
}

export function createSessionCookie(identity: Omit<InvookSession, "expiresAt">): string {
  const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
  return serializeCookie(
    SESSION_COOKIE,
    serializeSession({ ...identity, expiresAt }),
    {
      ...cookieOptions(),
      expires: new Date(expiresAt),
      maxAge: SESSION_DURATION_SECONDS,
    },
  );
}

export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, "", {
    ...cookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
}
