import type { FastifyPluginAsync } from "fastify";

import { getMcpResourceUrl } from "@invook/auth";
import type { McpConnectionsResponse } from "@invook/contracts";
import { listMcpConnections, revokeMcpConnection } from "@invook/database";

import { mutationAccessHooks, requireSession } from "../access";
import { getPublicAppOrigin } from "../config";
import { buildInvookSkill } from "../mcp/mcp-instructions";
import { sendJson, sendProblem } from "../responses";

/** OAuth client IDs as Better Auth's provider generates them. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type McpConnectionParams = { clientId: string };

export interface McpConnectionRouteDependencies {
  listConnections: typeof listMcpConnections;
  revokeConnection: typeof revokeMcpConnection;
}

const defaultDependencies: McpConnectionRouteDependencies = {
  listConnections: listMcpConnections,
  revokeConnection: revokeMcpConnection,
};

/** Lets a signed-in person set up agents and disconnect the ones they authorized. */
export function registerMcpConnectionRoutes(
  overrides: Partial<McpConnectionRouteDependencies> = {},
): FastifyPluginAsync {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (api) => {
    api.get(
      "/v1/mcp/connections",
      { onRequest: requireSession },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const serverUrl = getMcpResourceUrl(getPublicAppOrigin());
        const connections = await dependencies.listConnections({
          userId: session.userId,
        });
        const response: McpConnectionsResponse = {
          serverUrl,
          skill: buildInvookSkill(serverUrl),
          connections: connections.map((connection) => ({
            clientId: connection.clientId,
            name: connection.name,
            connectedAt: connection.connectedAt.toISOString(),
            updatedAt: connection.updatedAt.toISOString(),
          })),
        };
        await sendJson(reply, 200, response);
      },
    );

    api.delete<{ Params: McpConnectionParams }>(
      "/v1/mcp/connections/:clientId",
      { onRequest: mutationAccessHooks },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        if (!CLIENT_ID_PATTERN.test(request.params.clientId)) {
          await sendProblem(request, reply, 400, "Agent connection ID must be valid");
          return;
        }
        const isRevoked = await dependencies.revokeConnection({
          userId: session.userId,
          clientId: request.params.clientId,
        });
        if (!isRevoked) {
          await sendProblem(request, reply, 404, "Agent connection not found");
          return;
        }
        await reply.code(204).send();
      },
    );
  };
}
