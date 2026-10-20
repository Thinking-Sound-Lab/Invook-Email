import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";

import type { MailAgentCapabilities, MailAgentToolCall } from "@invook/ai";
import { hashOAuthToken } from "@invook/auth";
import type { AgentEmailInput } from "@invook/contracts";
import type { McpAccessGrant } from "@invook/database";

import { buildApi } from "../app";
import type { AuthService } from "../auth/auth-service";
import { createInvookMcpServer, type McpServerDependencies } from "../mcp/mcp-server";
import type { AgentCapabilityScope } from "../services/agent-capabilities";

const appOrigin = "http://localhost:3000";
const userId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const clientId = "agentClientId";
const validToken = "a".repeat(32);
const readOnlyToken = "b".repeat(32);
const originalAppUrl = process.env.APP_URL;

const testAuth: AuthService = {
  handle: async () => new Response(null, { status: 404 }),
  getSession: async () => ({ session: null, setCookies: [] }),
  getAuthorizationServerMetadata: async () =>
    Response.json({ issuer: `${appOrigin}/v1/auth` }),
};

let api: FastifyInstance;
let grantLookups: string[] = [];
let capabilityScopes: AgentCapabilityScope[] = [];
let writes: Array<{ tool: "saveDraft" | "sendEmail"; email: AgentEmailInput; call: MailAgentToolCall }> = [];
let threadActions: Array<{ userId: string; action: string }> = [];
let searchFailure: Error | null = null;
let toolCallCount = 0;

const grantsByToken = new Map<string, McpAccessGrant>([
  [validToken, { userId, clientId, scopes: ["mail", "offline_access"] }],
  [readOnlyToken, { userId, clientId, scopes: ["offline_access"] }],
]);

const capabilities: MailAgentCapabilities = {
  resolveEmail: async (email) =>
    email.replyToMessageId ? { ...email, subject: "Re: Quarterly plan" } : email,
  searchMail: async (input) => {
    if (searchFailure) throw searchFailure;
    return {
      status: "available",
      results: [
        {
          accountId,
          threadId,
          messageId,
          subject: `Results for ${input.query}`,
          sender: "Ada <ada@example.com>",
          sentAt: "2026-10-01T09:00:00.000Z",
          preview: "The plan is attached.",
          attachmentFilenames: [],
        },
      ],
    };
  },
  readThread: async () => ({ status: "unavailable" }),
  saveDraft: async (email, call) => {
    writes.push({ tool: "saveDraft", email, call });
    return {
      status: "saved",
      accountId,
      providerDraftId: "r-1",
      providerThreadId: "provider-thread",
    };
  },
  sendEmail: async (email, call) => {
    writes.push({ tool: "sendEmail", email, call });
    return {
      status: "sent",
      accountId,
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    };
  },
};

const serverDependencies: McpServerDependencies = {
  createCapabilities: (scope) => {
    capabilityScopes.push(scope);
    return capabilities;
  },
  getShell: async (requestedUserId) => {
    assert.equal(requestedUserId, userId);
    return {
      accounts: [
        {
          id: accountId,
          email: "owner@example.com",
          image: null,
          status: "connected",
          syncState: { mailSync: "complete" },
          lastSyncedAt: null,
          replica: { state: "ready", readyAt: null },
        },
      ],
      accountLabels: [
        {
          accountId,
          labels: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              name: "Billing",
              description: "Invoices and receipts",
              systemKey: "billing",
              definitionVersion: 1,
              isEnabled: true,
              normalizedName: "billing",
            },
          ],
        },
      ],
    };
  },
  listThreads: async () => null,
  getThreadContext: async (input) =>
    input.userId === userId && input.threadId === threadId
      ? { accountId, providerThreadId: "provider-thread" }
      : null,
  getProviderAccess: async () => ({
    status: "ready",
    access: { accountId, accessToken: "gmail-token", email: "owner@example.com" },
  }),
  applyThreadAction: async (input) => {
    threadActions.push({ userId: input.userId, action: input.action });
    return { status: "complete", stepId: "step" };
  },
  generateToolCallId: () => `tool-call-${(toolCallCount += 1)}`,
};

/** Routes the SDK client's HTTP requests into the Fastify app without a socket. */
const injectFetch: FetchLike = async (url, init) => {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const response = await api.inject({
    method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
    url: `${target.pathname}${target.search}`,
    headers,
    payload: typeof init?.body === "string" ? init.body : undefined,
  });
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === "string") responseHeaders.set(name, value);
  }
  return new Response(response.statusCode === 204 ? null : response.rawPayload, {
    status: response.statusCode,
    headers: responseHeaders,
  });
};

async function connectAgent(mode: VersionNegotiationMode): Promise<Client> {
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${appOrigin}/mcp`), {
      fetch: injectFetch,
      requestInit: { headers: { authorization: `Bearer ${validToken}` } },
    }),
  );
  return client;
}

function parseToolText(result: CallToolResult): unknown {
  const [content] = result.content;
  assert.equal(content?.type, "text");
  return content?.type === "text" ? JSON.parse(content.text) : null;
}

before(async () => {
  process.env.APP_URL = appOrigin;
  api = await buildApi({
    auth: testAuth,
    mcpRoutes: {
      getAccessGrant: async ({ tokenHash }) => {
        grantLookups.push(tokenHash);
        for (const [token, grant] of grantsByToken) {
          if (hashOAuthToken(token) === tokenHash) return grant;
        }
        return null;
      },
      createServer: (identity) => createInvookMcpServer(identity, serverDependencies),
    },
  });
});

beforeEach(() => {
  grantLookups = [];
  capabilityScopes = [];
  writes = [];
  threadActions = [];
  searchFailure = null;
  toolCallCount = 0;
});

after(async () => {
  await api.close();
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
});

test("an agent without a token is pointed at Invook's authorization server", async () => {
  const response = await api.inject({ method: "POST", url: "/mcp", payload: {} });

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.headers["www-authenticate"],
    `Bearer resource_metadata="${appOrigin}/.well-known/oauth-protected-resource/mcp", scope="mail offline_access"`,
  );

  const metadata = await api.inject({
    method: "GET",
    url: "/.well-known/oauth-protected-resource/mcp",
  });
  assert.equal(metadata.statusCode, 200);
  assert.deepEqual(metadata.json(), {
    resource: `${appOrigin}/mcp`,
    authorization_servers: [`${appOrigin}/v1/auth`],
    scopes_supported: ["mail", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Invook",
  });

  const authorizationServer = await api.inject({
    method: "GET",
    url: "/.well-known/oauth-authorization-server/v1/auth",
  });
  assert.equal(authorizationServer.statusCode, 200);
  assert.deepEqual(authorizationServer.json(), { issuer: `${appOrigin}/v1/auth` });
});

test("unknown, malformed, and under-scoped tokens never reach the MCP server", async () => {
  const unknown = await api.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${"z".repeat(32)}` },
    payload: {},
  });
  assert.equal(unknown.statusCode, 401);
  assert.match(String(unknown.headers["www-authenticate"]), /^Bearer error="invalid_token", /);

  const malformed = await api.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: "Basic dXNlcjpwYXNz" },
    payload: {},
  });
  assert.equal(malformed.statusCode, 401);
  assert.equal(grantLookups.length, 1, "a malformed header is refused before any lookup");

  const underScoped = await api.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${readOnlyToken}` },
    payload: {},
  });
  assert.equal(underScoped.statusCode, 403);
  assert.match(
    String(underScoped.headers["www-authenticate"]),
    /^Bearer error="insufficient_scope", /,
  );
  assert.deepEqual(capabilityScopes, []);
});

test("a page on another origin cannot use an agent's token", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${validToken}`,
      origin: "https://attacker.example",
    },
    payload: {},
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(grantLookups, []);
});

for (const mode of ["legacy", "auto"] as const) {
  test(`a connected agent sees Invook's tools and reads mail as its user (${mode} negotiation)`, async () => {
    const client = await connectAgent(mode);
    try {
      assert.match(client.getInstructions() ?? "", /Gmail stays the source of truth/);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        [
          "list_accounts",
          "list_threads",
          "read_thread",
          "save_draft",
          "search_mail",
          "send_email",
          "update_thread",
        ],
      );
      const sendTool = tools.find((tool) => tool.name === "send_email");
      assert.equal(sendTool?.annotations?.destructiveHint, true);
      assert.equal(
        tools.find((tool) => tool.name === "search_mail")?.annotations?.readOnlyHint,
        true,
      );

      const accounts = await client.callTool({ name: "list_accounts", arguments: {} });
      assert.deepEqual(parseToolText(accounts), {
        accounts: [
          {
            accountId,
            email: "owner@example.com",
            status: "connected",
            labels: [
              {
                labelId: "55555555-5555-4555-8555-555555555555",
                name: "Billing",
                description: "Invoices and receipts",
              },
            ],
          },
        ],
      });
      assert.ok(capabilityScopes.length > 0);
      assert.ok(
        capabilityScopes.every(
          (scope) => scope.userId === userId && scope.writeScopeId === clientId,
        ),
        "every request is bound to the token's user and client",
      );
    } finally {
      await client.close();
    }
  });
}

test("each draft and send gets its own idempotency key and Invook's reply subject", async () => {
  const client = await connectAgent("legacy");
  try {
    const email = {
      accountId,
      to: ["ada@example.com"],
      body: "Thanks, Ada.",
      replyToMessageId: messageId,
    };
    const draft = await client.callTool({ name: "save_draft", arguments: email });
    const sent = await client.callTool({ name: "send_email", arguments: email });
    const sentAgain = await client.callTool({ name: "send_email", arguments: email });

    assert.equal(draft.isError, undefined);
    assert.deepEqual(parseToolText(sent), {
      status: "sent",
      accountId,
      providerMessageId: "provider-message",
      providerThreadId: "provider-thread",
    });
    assert.equal(sentAgain.isError, undefined);
    assert.deepEqual(
      writes.map((write) => [write.tool, write.call.toolCallId, write.email.subject]),
      [
        ["saveDraft", "tool-call-1", "Re: Quarterly plan"],
        ["sendEmail", "tool-call-2", "Re: Quarterly plan"],
        ["sendEmail", "tool-call-3", "Re: Quarterly plan"],
      ],
    );
    assert.deepEqual(writes[0]?.email, {
      accountId,
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Quarterly plan",
      body: "Thanks, Ada.",
      replyToMessageId: messageId,
      forwardOfMessageId: null,
      draftId: null,
    });
  } finally {
    await client.close();
  }
});

test("thread changes reach Gmail only through a thread the user owns", async () => {
  const client = await connectAgent("legacy");
  try {
    const archived = await client.callTool({
      name: "update_thread",
      arguments: { threadId, action: "archive" },
    });
    const missing = await client.callTool({
      name: "update_thread",
      arguments: { threadId: "66666666-6666-4666-8666-666666666666", action: "mark_read" },
    });

    assert.deepEqual(parseToolText(archived), {
      status: "updated",
      threadId,
      action: "archive",
    });
    assert.equal(missing.isError, true);
    assert.deepEqual(parseToolText(missing), {
      status: "failed",
      reason: "That thread is not available in Invook.",
    });
    assert.deepEqual(threadActions, [{ userId, action: "archive" }]);
  } finally {
    await client.close();
  }
});

test("listing threads without a connected account says how to fix it", async () => {
  const client = await connectAgent("legacy");
  try {
    const everyAccount = await client.callTool({ name: "list_threads", arguments: {} });
    const oneAccount = await client.callTool({
      name: "list_threads",
      arguments: { accountId },
    });

    assert.deepEqual(parseToolText(everyAccount), {
      status: "failed",
      reason: "No Gmail account is connected to Invook yet. The user can connect one in Invook.",
    });
    assert.deepEqual(parseToolText(oneAccount), {
      status: "failed",
      reason: "That Gmail account is not connected to Invook.",
    });
  } finally {
    await client.close();
  }
});

test("an unexpected failure is reported without its internal details", async () => {
  searchFailure = new Error("connection to postgres://secret failed");
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...input: unknown[]) => {
    logged.push(input);
  };
  const client = await connectAgent("legacy");
  try {
    const result = await client.callTool({
      name: "search_mail",
      arguments: { query: "plan" },
    });

    assert.equal(result.isError, true);
    assert.deepEqual(parseToolText(result), {
      status: "failed",
      reason: "Invook could not complete this request.",
    });
    assert.doesNotMatch(JSON.stringify(logged), /postgres:\/\/secret/);
  } finally {
    console.error = originalConsoleError;
    await client.close();
  }
});
