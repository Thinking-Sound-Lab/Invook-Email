import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { createWebHeaders } from "../auth/auth-service";
import { getPublicAppOrigin } from "../config";
import { sendProblem } from "../responses";

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

async function sendAuthResponse(
  response: Response,
  reply: FastifyReply,
): Promise<void> {
  const setCookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "content-length") {
      reply.header(name, value);
    }
  });
  if (setCookies.length > 0) reply.header("set-cookie", setCookies);

  reply.status(response.status);
  if (!response.body) {
    await reply.send();
    return;
  }
  await reply.send(Buffer.from(await response.arrayBuffer()));
}

export const registerAuthRoutes: FastifyPluginAsync = async (api) => {
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
    await sendAuthResponse(response, reply);
  });
};
