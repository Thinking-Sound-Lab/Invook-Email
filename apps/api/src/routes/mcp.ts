import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  AUTH_BASE_PATH,
  getAuthorizationServerIssuer,
  getMcpResourceUrl,
  hashOAuthToken,
} from "@invook/auth";
import { MCP_MAIL_SCOPE, MCP_PATH } from "@invook/contracts";
import { getMcpAccessGrant } from "@invook/database";

import { createWebHeaders } from "../auth/auth-service";
import { getPublicAppOrigin } from "../config";
import {
  buildBearerChallenge,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  readBearerToken,
  readMcpIdentity,
  toMcpAuthInfo,
} from "../mcp/mcp-access";
import { createInvookMcpServer, type McpIdentity } from "../mcp/mcp-server";
import { sendJson, sendProblem, sendWebResponse } from "../responses";

export interface McpRouteDependencies {
  getAccessGrant: typeof getMcpAccessGrant;
  createServer: (identity: McpIdentity) => McpServer;
}

const defaultDependencies: McpRouteDependencies = {
  getAccessGrant: getMcpAccessGrant,
  createServer: createInvookMcpServer,
};

/**
 * The request as the MCP SDK reads it. Fastify has already parsed the body,
 * which is handed over separately, so the body's length header is dropped.
 */
function createWebRequest(request: FastifyRequest): Request {
  const headers = createWebHeaders(request.headers);
  headers.delete("content-length");
  return new Request(new URL(request.raw.url ?? request.url, getPublicAppOrigin()), {
    method: request.method,
    headers,
  });
}

async function sendChallenge(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { status: 401 | 403; error?: "invalid_token" | "insufficient_scope" },
): Promise<void> {
  reply.header(
    "www-authenticate",
    buildBearerChallenge({
      resourceMetadataUrl: getProtectedResourceMetadataUrl(getPublicAppOrigin()),
      ...(input.error ? { error: input.error } : {}),
    }),
  );
  await sendProblem(
    request,
    reply,
    input.status,
    input.status === 401 ? "Authentication required" : "Insufficient scope",
  );
}

/**
 * Serves Invook's MCP server and the discovery documents agents read before
 * signing in. Each request is authorized by an opaque access token issued by
 * Better Auth's OAuth provider and looked up by hash, so revoking a connection
 * takes effect on the agent's next request.
 */
export function registerMcpRoutes(
  overrides: Partial<McpRouteDependencies> = {},
): FastifyPluginAsync {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (api) => {
    // Stateless: every request gets a fresh server bound to its verified
    // grant, so any API instance can serve any agent.
    const handler = createMcpHandler(
      ({ authInfo }) => {
        const identity = readMcpIdentity(authInfo);
        if (!identity) {
          throw new Error("An MCP request reached the server without a verified grant.");
        }
        return dependencies.createServer(identity);
      },
      {
        onerror: (error) => {
          console.error("api: mcp request rejected", { name: error.name });
        },
      },
    );
    api.addHook("onClose", async () => {
      await handler.close();
    });

    api.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, async (_request, reply) => {
      const appOrigin = getPublicAppOrigin();
      await sendJson(
        reply,
        200,
        buildProtectedResourceMetadata({
          resource: getMcpResourceUrl(appOrigin),
          issuer: getAuthorizationServerIssuer(appOrigin),
        }),
      );
    });

    api.get(
      `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
      async (request, reply) => {
        const response = await request.server.invookAuth.getAuthorizationServerMetadata(
          createWebRequest(request),
        );
        await sendWebResponse(response, reply);
      },
    );

    api.route({
      method: ["GET", "POST", "DELETE"],
      url: MCP_PATH,
      handler: async (request, reply) => {
        // Agents call from servers and native apps. A browser page on another
        // origin is refused, which also defeats DNS rebinding.
        const origin = request.headers.origin;
        if (origin && origin !== getPublicAppOrigin()) {
          await sendProblem(request, reply, 403, "Request origin is not allowed");
          return;
        }
        const token = readBearerToken(request.headers.authorization);
        if (!token) {
          await sendChallenge(request, reply, { status: 401 });
          return;
        }
        const grant = await dependencies.getAccessGrant({
          tokenHash: hashOAuthToken(token),
        });
        if (!grant) {
          await sendChallenge(request, reply, { status: 401, error: "invalid_token" });
          return;
        }
        if (!grant.scopes.includes(MCP_MAIL_SCOPE)) {
          await sendChallenge(request, reply, {
            status: 403,
            error: "insufficient_scope",
          });
          return;
        }
        const response = await handler.fetch(createWebRequest(request), {
          authInfo: toMcpAuthInfo({
            token,
            identity: { userId: grant.userId, clientId: grant.clientId },
            scopes: grant.scopes,
          }),
          ...(request.body === null || request.body === undefined
            ? {}
            : { parsedBody: request.body }),
        });
        await sendWebResponse(response, reply);
      },
    });
  };
}
