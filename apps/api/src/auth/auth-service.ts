import type { FastifyRequest } from "fastify";

import {
  createInvookAuth,
  getAuthorizationServerMetadataResponse,
  getInvookSession,
  type InvookAuth,
  type InvookSessionResolution,
} from "@invook/auth";

import { getMissingApiConfiguration, getPublicAppOrigin } from "../config";

export interface AuthService {
  handle(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<InvookSessionResolution>;
  /** RFC 8414 metadata for the MCP authorization server. */
  getAuthorizationServerMetadata(request: Request): Promise<Response>;
}

function unconfiguredResponse(): Promise<Response> {
  return Promise.resolve(
    Response.json(
      { message: "Invook authentication is not configured." },
      { status: 503 },
    ),
  );
}

export function createWebHeaders(
  headers: FastifyRequest["headers"],
): Headers {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      webHeaders.append(name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(name, item);
    }
  }
  return webHeaders;
}

export function createAuthService(): AuthService {
  let auth: InvookAuth | null = null;

  const getAuth = (): InvookAuth => {
    auth ??= createInvookAuth({
      appUrl: getPublicAppOrigin(),
      secret: process.env.BETTER_AUTH_SECRET ?? "",
      googleClientId: process.env.BETTER_AUTH_GOOGLE_CLIENT_ID ?? "",
      googleClientSecret: process.env.BETTER_AUTH_GOOGLE_CLIENT_SECRET ?? "",
    });
    return auth;
  };

  return {
    handle: (request) => {
      if (getMissingApiConfiguration().length > 0) return unconfiguredResponse();
      return getAuth().handler(request);
    },
    getSession: (headers) => {
      if (getMissingApiConfiguration().length > 0) {
        return Promise.resolve({ session: null, setCookies: [] });
      }
      return getInvookSession(getAuth(), headers);
    },
    getAuthorizationServerMetadata: (request) => {
      if (getMissingApiConfiguration().length > 0) return unconfiguredResponse();
      return getAuthorizationServerMetadataResponse(getAuth(), request);
    },
  };
}
