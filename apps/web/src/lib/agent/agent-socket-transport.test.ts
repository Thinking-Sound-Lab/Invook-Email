import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_SOCKET_PROTOCOL,
  AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE,
  AGENT_SOCKET_TICKET_PROTOCOL_PREFIX,
  type AgentEmailInput,
  type AgentServerFrame,
  type InvookAgentUIMessage,
} from "@invook/contracts";

import {
  AgentSocketConnection,
  createAgentTurnFrame,
  readAgentServerFrame,
  type AgentSocketLike,
} from "./agent-socket-transport";

const conversationId = "33333333-3333-4333-8333-333333333333";
const focus = { accountSelection: "all", threadId: null };
const email: AgentEmailInput = {
  accountId: "22222222-2222-4222-8222-222222222222",
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Contract",
  body: "Signed.",
  replyToMessageId: null,
  forwardOfMessageId: null,
  draftId: null,
};

class FakeSocket implements AgentSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  private listeners: Array<{ type: string; listener: unknown }> = [];

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: string, listener: unknown): void {
    this.listeners.push({ type, listener });
  }

  removeEventListener(type: "open" | "close", listener: () => void): void {
    this.listeners = this.listeners.filter(
      (entry) => entry.type !== type || entry.listener !== listener,
    );
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.dispatch("close", { code });
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  receive(frame: AgentServerFrame | Record<string, unknown>): void {
    this.dispatch("message", { data: JSON.stringify(frame) });
  }

  private dispatch(type: string, event: { data?: unknown; code?: number }): void {
    for (const { type: listenerType, listener } of [...this.listeners]) {
      if (listenerType === type && typeof listener === "function") listener(event);
    }
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  let tickets = 0;
  const connection = new AgentSocketConnection({
    createTicket: async () => {
      tickets += 1;
      return {
        ticket: `${"T".repeat(42)}${tickets}`,
        socketUrl: "wss://agent.example/v1/agent/socket",
        expiresAt: "2026-10-18T09:01:00.000Z",
      };
    },
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      // The browser opens the socket after the handshake completes.
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  return { connection, sockets };
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return values;
    values.push(value);
  }
}

const messageFrame = {
  type: "message" as const,
  conversationId,
  messageId: "44444444-4444-4444-8444-444444444444",
  text: "Find the lease",
  focus,
};

test("only the newest user text or the user's approval decisions are sent", () => {
  const userTurn: InvookAgentUIMessage[] = [
    { id: "a", role: "assistant", parts: [{ type: "text", text: "Earlier" }] },
    { id: "b", role: "user", parts: [{ type: "text", text: "  Find the lease  " }] },
  ];
  assert.deepEqual(createAgentTurnFrame({ conversationId, messages: userTurn, focus }), {
    type: "message",
    conversationId,
    messageId: "b",
    text: "Find the lease",
    focus,
  });

  const decided: InvookAgentUIMessage[] = [
    {
      id: "c",
      role: "assistant",
      parts: [{
        type: "tool-sendEmail",
        toolCallId: "call-1",
        state: "approval-responded",
        input: email,
        approval: { id: "approval-1", approved: false },
      }],
    },
  ];
  assert.deepEqual(createAgentTurnFrame({ conversationId, messages: decided, focus }), {
    type: "approval",
    conversationId,
    decisions: [{ approvalId: "approval-1", approved: false }],
    focus,
  });

  assert.equal(createAgentTurnFrame({ conversationId, messages: [], focus }), null);
  assert.equal(
    createAgentTurnFrame({ conversationId, messages: userTurn.slice(0, 1), focus }),
    null,
  );
});

test("server frames are read only when they match the protocol", async () => {
  assert.deepEqual(
    await readAgentServerFrame(
      JSON.stringify({ type: "chunk", conversationId, chunk: { type: "text-delta", id: "t", delta: "Hi" } }),
    ),
    { type: "chunk", conversationId, chunk: { type: "text-delta", id: "t", delta: "Hi" } },
  );
  assert.deepEqual(
    await readAgentServerFrame(JSON.stringify({ type: "rejected", conversationId, reason: "busy" })),
    { type: "rejected", conversationId, reason: "busy" },
  );
  for (const invalid of [
    "not json",
    JSON.stringify({ type: "chunk", conversationId, chunk: { type: "text-delta" } }),
    JSON.stringify({ type: "rejected", conversationId, reason: "unknown" }),
    JSON.stringify({ type: "end" }),
  ]) {
    assert.equal(await readAgentServerFrame(invalid), null);
  }
});

test("a turn opens a ticketed socket and streams its chunks in order", async () => {
  const { connection, sockets } = harness();

  const stream = await connection.startTurn(messageFrame, undefined);
  const [socket] = sockets;
  assert.ok(socket);
  assert.deepEqual(socket.protocols, [
    AGENT_SOCKET_PROTOCOL,
    `${AGENT_SOCKET_TICKET_PROTOCOL_PREFIX}${"T".repeat(42)}1`,
  ]);
  assert.deepEqual(socket.sent, [messageFrame]);
  socket.receive({ type: "chunk", conversationId, chunk: { type: "start", messageId: "m" } });
  socket.receive({ type: "chunk", conversationId, chunk: { type: "text-start", id: "t" } });
  socket.receive({ type: "chunk", conversationId: "another", chunk: { type: "start" } });
  socket.receive({ type: "end", conversationId });

  assert.deepEqual(await readAll(stream), [
    { type: "start", messageId: "m" },
    { type: "text-start", id: "t" },
  ]);
});

test("a rejected turn and a closed socket surface plain errors", async () => {
  const { connection, sockets } = harness();
  const rejected = await connection.startTurn(messageFrame, undefined);
  sockets[0]?.receive({ type: "rejected", conversationId, reason: "busy" });
  await assert.rejects(readAll(rejected), /still working on this conversation/);

  const interrupted = await connection.startTurn(messageFrame, undefined);
  sockets[0]?.close(AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE);
  await assert.rejects(readAll(interrupted), /Your session ended/);

  // The next turn opens a new socket with a new one-time ticket.
  await connection.startTurn(messageFrame, undefined);
  assert.equal(sockets.length, 2);
  assert.notDeepEqual(sockets[0]?.protocols, sockets[1]?.protocols);
});

test("stopping a turn tells the server, settles its stream, and frees the conversation", async () => {
  const { connection, sockets } = harness();
  const controller = new AbortController();
  const stream = await connection.startTurn(messageFrame, controller.signal);
  await assert.rejects(
    connection.startTurn(messageFrame, undefined),
    /still working on this conversation/,
  );

  controller.abort();

  assert.deepEqual(sockets[0]?.sent.at(-1), { type: "stop", conversationId });
  assert.deepEqual(await readAll(stream), []);
  // A late frame for the stopped turn is ignored rather than misrouted.
  sockets[0]?.receive({ type: "end", conversationId });
  await connection.startTurn(messageFrame, undefined);
});

test("a stop pressed while the socket opens never reaches the server", async () => {
  const { connection, sockets } = harness();
  const controller = new AbortController();

  const started = connection.startTurn(messageFrame, controller.signal);
  controller.abort();

  await assert.rejects(started, (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(sockets[0]?.sent ?? [], []);
});

test("an unreadable frame fails the turn instead of showing partial data", async () => {
  const { connection, sockets } = harness();
  const stream = await connection.startTurn(messageFrame, undefined);
  sockets[0]?.receive({ type: "chunk", conversationId, chunk: { type: "unknown-part" } });
  await assert.rejects(readAll(stream), /could not read/);
});
