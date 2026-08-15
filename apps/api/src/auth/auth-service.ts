import type { FastifyRequest } from "fastify";

import {
  createInvookAuth,
  getInvookSession,
  type InvookAuth,
  type InvookSession,
} from "@invook/auth";

import { getMissingApiConfiguration, getPublicAppOrigin } from "../config";

export interface AuthService {
  handle(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<InvookSession | null>;
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
      if (getMissingApiConfiguration().length > 0) {
        return Promise.resolve(
          Response.json(
            { message: "Invook authentication is not configured." },
            { status: 503 },
          ),
        );
      }
      return getAuth().handler(request);
    },
    getSession: (headers) => {
      if (getMissingApiConfiguration().length > 0) return Promise.resolve(null);
      return getInvookSession(getAuth(), headers);
    },
  };
}
