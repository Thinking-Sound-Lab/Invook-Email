import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { usesSecureCookies } from "../config";
import { readCookies, serializeCookie } from "../http/cookies";

const OAUTH_STATE_COOKIE = "invook_oauth_state";
const OAUTH_VERIFIER_COOKIE = "invook_oauth_verifier";
const OAUTH_COOKIE_DURATION_SECONDS = 10 * 60;
const URL_NAMESPACE = "6ba7b8119dad11d180b400c04fd430c8";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: usesSecureCookies(),
    path: "/auth/callback",
  };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function createOAuthRequestCookies(state: string, codeVerifier: string): string[] {
  const options = {
    ...cookieOptions(),
    maxAge: OAUTH_COOKIE_DURATION_SECONDS,
  };
  return [
    serializeCookie(OAUTH_STATE_COOKIE, state, options),
    serializeCookie(OAUTH_VERIFIER_COOKIE, codeVerifier, options),
  ];
}

export function readOAuthRequest(request: IncomingMessage) {
  const cookies = readCookies(request);
  return {
    state: cookies.get(OAUTH_STATE_COOKIE),
    codeVerifier: cookies.get(OAUTH_VERIFIER_COOKIE),
  };
}

export function clearOAuthRequestCookies(): string[] {
  const options = {
    ...cookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  };
  return [
    serializeCookie(OAUTH_STATE_COOKIE, "", options),
    serializeCookie(OAUTH_VERIFIER_COOKIE, "", options),
  ];
}

export function isMatchingOAuthState(expected: string | undefined, actual: string | null) {
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export function getInvookUserId(googleSubject: string): string {
  const namespace = Buffer.from(URL_NAMESPACE, "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(`https://invook.dev/google/${googleSubject}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
