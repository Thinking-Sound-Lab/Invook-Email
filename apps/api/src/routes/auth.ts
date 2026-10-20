import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { createWebHeaders } from "../auth/auth-service";
import { getPublicAppOrigin } from "../config";
import { sendProblem, sendWebResponse } from "../responses";

function requestBody(request: FastifyRequest): string | undefined {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (request.body === null || request.body === undefined) return undefined;
  if (typeof request.body === "string") return request.body;
  return JSON.stringify(request.body);
}

function createAuthRequest(request: FastifyRequest): Request {
  return new Request(new URL(request.raw.url ?? request.url, getPublicAppOrigin()), {
    method: request.method,
    headers: createWebHeaders(request.headers),
    body: requestBody(request),
  });
}

function hasDisallowedGoogleAuthInput(request: FastifyRequest): boolean {
  const pathname = new URL(request.raw.url ?? request.url, getPublicAppOrigin())
    .pathname;
  if (request.method !== "POST" || pathname !== "/v1/auth/sign-in/social") {
    return false;
  }
  if (typeof request.body !== "object" || request.body === null) return false;
  return (
    !("provider" in request.body) ||
    request.body.provider !== "google" ||
    "scopes" in request.body ||
    "idToken" in request.body
  );
}

export const registerAuthRoutes: FastifyPluginAsync = async (api) => {
  // OAuth token and revocation requests are form-encoded (RFC 6749 4.1.3,
  // RFC 7009). Only this plugin's routes accept them, as the raw body that
  // Better Auth parses itself; every other route still requires JSON.
  api.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    async (_request: FastifyRequest, body: string) => body,
  );

  api.all("/v1/auth/*", async (request, reply) => {
    if (hasDisallowedGoogleAuthInput(request)) {
      await sendProblem(
        request,
        reply,
        400,
        "Google authentication accepts identity scopes only",
      );
      return;
    }
    const response = await request.server.invookAuth.handle(
      createAuthRequest(request),
    );
    await sendWebResponse(response, reply);
  });
};
