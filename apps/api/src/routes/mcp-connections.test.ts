import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { FastifyInstance } from "fastify";

import type { InvookSession } from "@invook/auth";
import type { McpConnectionsResponse } from "@invook/contracts";

import { buildApi } from "../app";
import type { AuthService } from "../auth/auth-service";

const appOrigin = "http://localhost:3000";
const userId = "11111111-1111-4111-8111-111111111111";
const clientId = "agentClientId";
const originalAppUrl = process.env.APP_URL;

const testAuth: AuthService = {
  handle: async () => new Response(null, { status: 404 }),
  getAuthorizationServerMetadata: async () => new Response(null, { status: 404 }),
  getSession: async (headers) => {
    if (!headers.get("cookie")?.includes("test_session=1")) {
      return { session: null, setCookies: [] };
    }
    const session: InvookSession = {
      userId,
      sessionId: "99999999-9999-4999-8999-999999999999",
      user: { email: "owner@example.com", image: null, name: "Owner" },
      expiresAt: new Date(Date.now() + 60_000),
    };
    return { session, setCookies: [] };
  },
};

let api: FastifyInstance;
let revocations: Array<{ userId: string; clientId: string }> = [];

before(async () => {
  process.env.APP_URL = appOrigin;
  api = await buildApi({
    auth: testAuth,
    mcpConnectionRoutes: {
      listConnections: async (input) =>
        input.userId === userId
          ? [
              {
                clientId,
                name: "Claude Code",
                connectedAt: new Date("2026-10-01T09:00:00.000Z"),
                updatedAt: new Date("2026-10-02T09:00:00.000Z"),
              },
            ]
          : [],
      revokeConnection: async (input) => {
        revocations.push(input);
        return input.clientId === clientId;
      },
    },
  });
});

beforeEach(() => {
  revocations = [];
});

after(async () => {
  await api.close();
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

test("connecting agents requires a signed-in person", async () => {
  const listed = await api.inject({ method: "GET", url: "/v1/mcp/connections" });
  const revoked = await api.inject({
    method: "DELETE",
    url: `/v1/mcp/connections/${clientId}`,
  });

  assert.equal(listed.statusCode, 401);
  assert.equal(revoked.statusCode, 401);
  assert.deepEqual(revocations, []);
});

test("a person sees this installation's server, its skill, and their agents", async () => {
  const response = await api.inject({
    method: "GET",
    url: "/v1/mcp/connections",
    headers: { cookie: "test_session=1" },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json<McpConnectionsResponse>();
  assert.equal(body.serverUrl, `${appOrigin}/mcp`);
  assert.match(body.skill, /^---\nname: invook\n/);
  assert.ok(body.skill.includes(`${appOrigin}/mcp`));
  assert.deepEqual(body.connections, [
    {
      clientId,
      name: "Claude Code",
      connectedAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-02T09:00:00.000Z",
    },
  ]);
});

test("disconnecting an agent is scoped to the signed-in person", async () => {
  const revoked = await api.inject({
    method: "DELETE",
    url: `/v1/mcp/connections/${clientId}`,
    headers: { cookie: "test_session=1", origin: appOrigin },
  });
  const unknown = await api.inject({
    method: "DELETE",
    url: "/v1/mcp/connections/unknownClient",
    headers: { cookie: "test_session=1", origin: appOrigin },
  });
  const malformed = await api.inject({
    method: "DELETE",
    url: "/v1/mcp/connections/not%20an%20id",
    headers: { cookie: "test_session=1", origin: appOrigin },
  });

  assert.equal(revoked.statusCode, 204);
  assert.equal(unknown.statusCode, 404);
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(revocations, [
    { userId, clientId },
    { userId, clientId: "unknownClient" },
  ]);
});

test("another origin cannot disconnect a person's agent", async () => {
  const response = await api.inject({
    method: "DELETE",
    url: `/v1/mcp/connections/${clientId}`,
    headers: { cookie: "test_session=1", origin: "https://attacker.example" },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(revocations, []);
});
