import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";

import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

import type { InvookSession } from "@invook/auth";
import {
  AGENT_MESSAGE_MAX_LENGTH,
  AGENT_SOCKET_PROTOCOL,
  AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE,
  AGENT_SOCKET_TICKET_PROTOCOL_PREFIX,
  type AgentServerFrame,
} from "@invook/contracts";

import { buildApi } from "../app";
import type { AuthService } from "../auth/auth-service";
import type { AgentTurnInput, AgentTurnResult } from "../services/agent-turns";
import { parseAgentClientFrame } from "./agent";

const appOrigin = "http://localhost:3000";
const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "99999999-9999-4999-8999-999999999999";
const conversationId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const ticket = "T".repeat(43);
const focus = { accountSelection: "all", threadId: null };
const originalEnvironment = {
  APP_URL: process.env.APP_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  AGENT_SOCKET_URL: process.env.AGENT_SOCKET_URL,
};

type TurnBehavior = (input: AgentTurnInput) => Promise<AgentTurnResult>;

let api: FastifyInstance;
let turns: AgentTurnInput[] = [];
let redeemedTickets: string[] = [];
let turnBehavior: TurnBehavior;

const testAuth: AuthService = {
  handle: async () => new Response(null, { status: 404 }),
  getAuthorizationServerMetadata: async () => new Response(null, { status: 404 }),
  getSession: async (headers) => {
    if (!headers.get("cookie")?.includes("test_session=1")) {
      return { session: null, setCookies: [] };
    }
    const session: InvookSession = {
      userId,
      sessionId,
      user: { email: "owner@example.com", image: null, name: "Owner" },
      expiresAt: new Date(Date.now() + 60_000),
    };
    return { session, setCookies: [] };
  },
};

function streamOneChunk(): TurnBehavior {
  return async (input) => {
    input.send({
      type: "chunk",
      conversationId: input.frame.conversationId,
      chunk: { type: "start", messageId: "assistant-message" },
    });
    input.send({ type: "end", conversationId: input.frame.conversationId });
    return { isSessionEnded: false };
  };
}

function messageFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    conversationId,
    messageId,
    text: "Draft a reply to this email",
    focus,
    ...overrides,
  };
}

let socketUrl = "";

/** Opens a real socket the way a browser does: offered subprotocols and an Origin. */
async function openSocket(
  input: { origin?: string; protocols?: string[] } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(
    socketUrl,
    input.protocols ?? [
      AGENT_SOCKET_PROTOCOL,
      `${AGENT_SOCKET_TICKET_PROTOCOL_PREFIX}${ticket}`,
    ],
    { origin: input.origin ?? appOrigin },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`Unexpected server response: ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
  return socket;
}

function nextFrames(socket: WebSocket, count: number): Promise<AgentServerFrame[]> {
  return new Promise((resolve) => {
    const frames: AgentServerFrame[] = [];
    const handleMessage = (data: Buffer) => {
      frames.push(JSON.parse(data.toString("utf8")) as AgentServerFrame);
      if (frames.length < count) return;
      socket.off("message", handleMessage);
      resolve(frames);
    };
    socket.on("message", handleMessage);
  });
}

before(async () => {
  process.env.APP_URL = appOrigin;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.AGENT_SOCKET_URL = "ws://localhost:4000/v1/agent/socket";
  api = await buildApi({
    auth: testAuth,
    agentRoutes: {
      redeemTicket: async (value) => {
        redeemedTickets.push(value);
        return value === ticket ? { userId, sessionId } : null;
      },
      runTurn: (input) => {
        turns.push(input);
        return turnBehavior(input);
      },
    },
  });
  await api.listen({ host: "127.0.0.1", port: 0 });
  const address = api.server.address();
  assert.ok(address && typeof address === "object");
  socketUrl = `ws://127.0.0.1:${address.port}/v1/agent/socket`;
});

beforeEach(() => {
  turns = [];
  redeemedTickets = [];
  turnBehavior = streamOneChunk();
});

after(async () => {
  await api.close();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("client frames accept only the documented shapes", () => {
  assert.deepEqual(parseAgentClientFrame(messageFrame({ text: "  Reply yes  " })), {
    ...messageFrame(),
    text: "Reply yes",
  });
  assert.deepEqual(parseAgentClientFrame({ type: "stop", conversationId }), {
    type: "stop",
    conversationId,
  });
  assert.deepEqual(
    parseAgentClientFrame({
      type: "approval",
      conversationId,
      decisions: [{ approvalId: "approval-1", approved: true }],
      focus: { accountSelection: userId, threadId: messageId },
    }),
    {
      type: "approval",
      conversationId,
      decisions: [{ approvalId: "approval-1", approved: true }],
      focus: { accountSelection: userId, threadId: messageId },
    },
  );
  for (const invalid of [
    null,
    messageFrame({ userId }),
    messageFrame({ conversationId: "conversation" }),
    messageFrame({ messageId: "message" }),
    messageFrame({ text: "   " }),
    messageFrame({ text: "x".repeat(AGENT_MESSAGE_MAX_LENGTH + 1) }),
    messageFrame({ focus: { accountSelection: "everything", threadId: null } }),
    messageFrame({ focus: { accountSelection: "all", threadId: "thread" } }),
    messageFrame({ focus: { accountSelection: "all", threadId: null, body: "x" } }),
    { type: "approval", conversationId, decisions: [], focus },
    {
      type: "approval",
      conversationId,
      decisions: [{ approvalId: "approval-1", approved: "yes" }],
      focus,
    },
    {
      type: "approval",
      conversationId,
      decisions: [{ approvalId: "approval-1", approved: true, input: {} }],
      focus,
    },
    { type: "stop", conversationId, reason: "x" },
    { type: "regenerate", conversationId },
  ]) {
    assert.equal(parseAgentClientFrame(invalid), null);
  }
});

test("the socket refuses an upgrade without a redeemed ticket from the app origin", async () => {
  await assert.rejects(
    openSocket({ protocols: [AGENT_SOCKET_PROTOCOL] }),
    /Unexpected server response: 401/,
  );
  await assert.rejects(
    openSocket({ origin: "https://attacker.example" }),
    /Unexpected server response: 403/,
  );
  await assert.rejects(
    openSocket({
      protocols: [
        AGENT_SOCKET_PROTOCOL,
        `${AGENT_SOCKET_TICKET_PROTOCOL_PREFIX}${"U".repeat(43)}`,
      ],
    }),
    /Unexpected server response: 401/,
  );
  // A foreign origin is refused before its ticket is spent.
  assert.deepEqual(redeemedTickets, ["U".repeat(43)]);
  assert.equal(turns.length, 0);
});

test("a message runs one turn as the ticket's identity and streams its frames", async () => {
  const socket = await openSocket();
  // The browser rejects a handshake that does not select an offered protocol,
  // and the one-time ticket must never be echoed back.
  assert.equal(socket.protocol, AGENT_SOCKET_PROTOCOL);
  const frames = nextFrames(socket, 2);
  socket.send(JSON.stringify(messageFrame()));

  assert.deepEqual(await frames, [
    {
      type: "chunk",
      conversationId,
      chunk: { type: "start", messageId: "assistant-message" },
    },
    { type: "end", conversationId },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.userId, userId);
  assert.equal(turns[0]?.sessionId, sessionId);
  assert.deepEqual(turns[0]?.frame, messageFrame());
  socket.terminate();
});

test("a socket runs one turn at a time and stop aborts the running turn", async () => {
  turnBehavior = async (input) => {
    await once(input.abortSignal, "abort");
    input.send({ type: "end", conversationId: input.frame.conversationId });
    return { isSessionEnded: false };
  };
  const socket = await openSocket();
  const busy = nextFrames(socket, 1);
  socket.send(JSON.stringify(messageFrame()));
  socket.send(
    JSON.stringify(
      messageFrame({ messageId: "55555555-5555-4555-8555-555555555555" }),
    ),
  );
  assert.deepEqual(await busy, [
    { type: "rejected", conversationId, reason: "busy" },
  ]);

  const ended = nextFrames(socket, 1);
  socket.send(JSON.stringify({ type: "stop", conversationId }));
  assert.deepEqual(await ended, [{ type: "end", conversationId }]);
  assert.equal(turns.length, 1);
  socket.terminate();
});

test("closing the socket aborts its running turn", async () => {
  let markTurnStarted = () => {};
  let markTurnAborted = () => {};
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const turnAborted = new Promise<void>((resolve) => {
    markTurnAborted = resolve;
  });
  turnBehavior = async (input) => {
    markTurnStarted();
    await once(input.abortSignal, "abort");
    markTurnAborted();
    return { isSessionEnded: false };
  };
  const socket = await openSocket();
  socket.send(JSON.stringify(messageFrame()));
  await turnStarted;
  socket.terminate();
  await turnAborted;
});

test("malformed frames close the socket without running a turn", async () => {
  const invalidFrame = await openSocket();
  const invalidClosed = once(invalidFrame, "close");
  invalidFrame.send(JSON.stringify(messageFrame({ text: "" })));
  const [invalidCode] = await invalidClosed;
  assert.equal(invalidCode, 1008);

  const binaryFrame = await openSocket();
  const binaryClosed = once(binaryFrame, "close");
  binaryFrame.send(Buffer.from(JSON.stringify(messageFrame())), { binary: true });
  const [binaryCode] = await binaryClosed;
  assert.equal(binaryCode, 1003);
  assert.equal(turns.length, 0);
});

test("an ended sign-in session closes the socket", async () => {
  turnBehavior = async (input) => {
    input.send({
      type: "rejected",
      conversationId: input.frame.conversationId,
      reason: "session_ended",
    });
    return { isSessionEnded: true };
  };
  const socket = await openSocket();
  const rejected = nextFrames(socket, 1);
  const closed = once(socket, "close");
  socket.send(JSON.stringify(messageFrame()));

  assert.deepEqual(await rejected, [
    { type: "rejected", conversationId, reason: "session_ended" },
  ]);
  const [code] = await closed;
  assert.equal(code, AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE);
});

test("ticket and conversation routes require a session and an honest configuration", async () => {
  const unauthenticated = await api.inject({
    method: "POST",
    url: "/v1/agent/socket-tickets",
    headers: { origin: appOrigin },
  });
  assert.equal(unauthenticated.statusCode, 401);

  const foreignOrigin = await api.inject({
    method: "POST",
    url: "/v1/agent/socket-tickets",
    headers: { origin: "https://attacker.example", cookie: "test_session=1" },
  });
  assert.equal(foreignOrigin.statusCode, 403);

  const configuredSocketUrl = process.env.AGENT_SOCKET_URL;
  delete process.env.AGENT_SOCKET_URL;
  try {
    const unconfigured = await api.inject({
      method: "POST",
      url: "/v1/agent/socket-tickets",
      headers: { origin: appOrigin, cookie: "test_session=1" },
    });
    assert.equal(unconfigured.statusCode, 503);
    assert.equal(unconfigured.json().title, "The agent is not configured on this server");
  } finally {
    process.env.AGENT_SOCKET_URL = configuredSocketUrl;
  }

  for (const url of [
    "/v1/agent/conversations",
    `/v1/agent/conversations/${conversationId}`,
  ]) {
    const response = await api.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401);
  }
  const invalidId = await api.inject({
    method: "GET",
    url: "/v1/agent/conversations/conversation",
    headers: { cookie: "test_session=1" },
  });
  assert.equal(invalidId.statusCode, 400);

  const unauthenticatedDelete = await api.inject({
    method: "DELETE",
    url: `/v1/agent/conversations/${conversationId}`,
    headers: { origin: appOrigin },
  });
  assert.equal(unauthenticatedDelete.statusCode, 401);
  const foreignDelete = await api.inject({
    method: "DELETE",
    url: `/v1/agent/conversations/${conversationId}`,
    headers: { origin: "https://attacker.example", cookie: "test_session=1" },
  });
  assert.equal(foreignDelete.statusCode, 403);
  const invalidDelete = await api.inject({
    method: "DELETE",
    url: "/v1/agent/conversations/conversation",
    headers: { origin: appOrigin, cookie: "test_session=1" },
  });
  assert.equal(invalidDelete.statusCode, 400);

  const plainRequest = await api.inject({ method: "GET", url: "/v1/agent/socket" });
  assert.equal(plainRequest.statusCode, 426);
});
