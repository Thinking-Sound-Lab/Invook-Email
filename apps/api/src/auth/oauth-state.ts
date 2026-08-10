import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { v5 as uuidv5 } from "uuid";

import { usesSecureCookies } from "../config";

const OAUTH_STATE_COOKIE = "invook_oauth_state";
const OAUTH_VERIFIER_COOKIE = "invook_oauth_verifier";
const OAUTH_COOKIE_DURATION_SECONDS = 10 * 60;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: usesSecureCookies(),
    path: "/auth/callback",
  };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function createOAuthRequestCookies(
  reply: FastifyReply,
  state: string,
  codeVerifier: string,
) {
  const options = {
    ...cookieOptions(),
    maxAge: OAUTH_COOKIE_DURATION_SECONDS,
  };
  reply.setCookie(OAUTH_STATE_COOKIE, state, options);
  reply.setCookie(OAUTH_VERIFIER_COOKIE, codeVerifier, options);
}

export function readOAuthRequest(request: FastifyRequest) {
  return {
    state: request.cookies[OAUTH_STATE_COOKIE],
    codeVerifier: request.cookies[OAUTH_VERIFIER_COOKIE],
  };
}

export function clearOAuthRequestCookies(reply: FastifyReply) {
  const options = {
    ...cookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  };
  reply.setCookie(OAUTH_STATE_COOKIE, "", options);
  reply.setCookie(OAUTH_VERIFIER_COOKIE, "", options);
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
  return uuidv5(`https://invook.dev/google/${googleSubject}`, uuidv5.URL);
}
