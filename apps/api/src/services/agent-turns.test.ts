import assert from "node:assert/strict";
import test from "node:test";

import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { MailAgentCapabilities } from "@invook/ai";
import type {
  AgentEmailInput,
  AgentServerFrame,
  AgentThreadContent,
} from "@invook/contracts";
import {
  AgentMessageConflictError,
  type StoredAgentMessage,
} from "@invook/database";

import {
  getConversationTitle,
  runAgentTurn,
  type AgentTurnDependencies,
  type AgentTurnFrame,
} from "./agent-turns";

type StreamPart = Parameters<
  typeof simulateReadableStream<
    Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
      ? Part
      : never
  >
>[0]["chunks"][number];

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "99999999-9999-4999-8999-999999999999";
const accountId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const threadId = "55555555-5555-4555-8555-555555555555";
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const email: AgentEmailInput = {
  accountId,
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Re: Contract",
  body: "Signed.",
  replyToMessageId: null,
  forwardOfMessageId: null,
  draftId: null,
};
const openThread: AgentThreadContent = {
  threadId,
  accountId,
  accountEmail: "owner@example.com",
  subject: "Contract",
  earlierMessageCount: 0,
  messages: [],
};

function textResponse(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ];
}

function toolCallResponse(toolName: string, input: unknown): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
  ];
}

function scriptedModel(responses: StreamPart[][]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = responses[call];
      call += 1;
      if (!chunks) throw new Error("The scripted model ran out of responses.");
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function harness(input: {
  model: MockLanguageModelV4;
  history?: StoredAgentMessage[];
  overrides?: Partial<AgentTurnDependencies>;
}) {
  const events: string[] = [];
  const savedMessages: Array<{ messages: StoredAgentMessage[]; finishRun: boolean }> = [];
  const toolCalls: Array<{ name: string; input: unknown; toolCallId?: string }> = [];
  let ids = 0;
  const capabilities: MailAgentCapabilities = {
    resolveEmail: async (email) => email,
    searchMail: async () => ({ status: "available", results: [] }),
    readThread: async (request) => {
      toolCalls.push({ name: "readThread", input: request });
      return request.threadId === threadId
        ? { status: "available", thread: openThread }
        : { status: "unavailable" };
    },
    saveDraft: async (email, { toolCallId }) => {
      toolCalls.push({ name: "saveDraft", input: email, toolCallId });
      return {
        status: "saved",
        accountId,
        providerDraftId: "provider-draft",
        providerThreadId: "provider-thread",
      };
    },
    sendEmail: async (email, { toolCallId }) => {
      toolCalls.push({ name: "sendEmail", input: email, toolCallId });
      return {
        status: "sent",
        accountId,
        providerMessageId: "sent-message",
        providerThreadId: "provider-thread",
      };
    },
  };
  const dependencies: AgentTurnDependencies = {
    getIdentity: async (identity) =>
      identity.userId === userId && identity.sessionId === sessionId
        ? { name: "Owner", email: "owner@example.com" }
        : null,
    listAccounts: async () => [
      { id: accountId, email: "owner@example.com", status: "connected" },
    ],
    startRun: async (request) => {
      events.push("start");
      return {
        outcome: "started",
        messages: [
          ...(input.history ?? []),
          ...(request.newMessage ? [request.newMessage.message] : []),
        ],
      };
    },
    saveRunMessages: async (request) => {
      events.push(request.finishRun ? "save-and-finish" : "save");
      savedMessages.push({ messages: request.messages, finishRun: request.finishRun });
      return { saved: true };
    },
    renewRun: async () => {
      events.push("renew");
      return true;
    },
    finishRun: async () => {
      events.push("release");
    },
    createCapabilities: (scope) => {
      assert.deepEqual(scope, { userId, conversationId });
      return capabilities;
    },
    getModel: () => ({ model: input.model }),
    generateId: () => `generated-${(ids += 1)}`,
    now: () => new Date("2026-10-18T09:00:00.000Z"),
    ...input.overrides,
  };
  const frames: AgentServerFrame[] = [];
  const run = (frame: AgentTurnFrame) =>
    runAgentTurn(
      {
        userId,
        sessionId,
        frame,
        abortSignal: new AbortController().signal,
        send: (serverFrame) => frames.push(serverFrame),
      },
      dependencies,
    );
  return { run, frames, events, savedMessages, toolCalls };
}

const messageFrame: AgentTurnFrame = {
  type: "message",
  conversationId,
  messageId,
  text: "Reply that the contract is signed",
  focus: { accountSelection: "all", threadId },
};

test("a message turn streams the answer and stores it before reporting the end", async () => {
  const model = scriptedModel([textResponse("I can draft that.")]);
  const { run, frames, events, savedMessages, toolCalls } = harness({ model });

  assert.deepEqual(await run(messageFrame), { isSessionEnded: false });

  assert.deepEqual(events, ["start", "renew", "save-and-finish"]);
  assert.equal(frames.at(-1)?.type, "end");
  assert.ok(frames.some(
    (frame) =>
      frame.type === "chunk" &&
      frame.chunk.type === "text-delta" &&
      frame.chunk.delta === "I can draft that.",
  ));
  assert.deepEqual(savedMessages[0]?.messages[0]?.role, "assistant");
  assert.deepEqual(savedMessages[0]?.messages[0]?.parts.at(-1), {
    type: "text",
    text: "I can draft that.",
    providerMetadata: undefined,
    state: "done",
  });
  // The open email is re-read under the user's scope and given to the model.
  assert.deepEqual(toolCalls, [{ name: "readThread", input: { threadId } }]);
  const system = model.doStreamCalls[0]?.prompt.find((message) => message.role === "system");
  assert.match(String(system?.content), /<open_thread>.*"threadId":"55555555/);
});

test("a send stops at the approval card, then runs once the user approves", async () => {
  const askModel = scriptedModel([toolCallResponse("sendEmail", email)]);
  const first = harness({ model: askModel });
  await first.run(messageFrame);

  const stored = first.savedMessages[0]?.messages[0];
  assert.ok(stored);
  assert.ok(first.frames.some(
    (frame) => frame.type === "chunk" && frame.chunk.type === "tool-approval-request",
  ));
  assert.deepEqual(first.toolCalls.map((call) => call.name), ["readThread"]);
  const pending = stored.parts.find(
    (part): part is { type: string; state: string; approval: { id: string } } =>
      typeof part === "object" && part !== null && "state" in part &&
      (part as { state: unknown }).state === "approval-requested",
  );
  assert.ok(pending);

  const approveModel = scriptedModel([textResponse("Sent.")]);
  const second = harness({
    model: approveModel,
    history: [
      { id: messageId, role: "user", parts: [{ type: "text", text: messageFrame.text }] },
      stored,
    ],
  });
  await second.run({
    type: "approval",
    conversationId,
    decisions: [{ approvalId: pending.approval.id, approved: true }],
    focus: { accountSelection: "all", threadId: null },
  });

  assert.deepEqual(second.events, ["start", "save", "renew", "save-and-finish"]);
  assert.equal(
    (second.savedMessages[0]?.messages[0]?.parts.find(
      (part) => typeof part === "object" && part !== null && "approval" in part,
    ) as { state: string } | undefined)?.state,
    "approval-responded",
  );
  assert.deepEqual(second.toolCalls, [
    { name: "sendEmail", input: email, toolCallId: "call-sendEmail" },
  ]);
  // The continuation extends the same assistant message.
  assert.equal(second.savedMessages[1]?.messages[0]?.id, stored.id);
});

test("an approval that does not match the pending request releases the turn untouched", async () => {
  const model = scriptedModel([]);
  const { run, frames, events, toolCalls } = harness({
    model,
    history: [
      { id: messageId, role: "user", parts: [{ type: "text", text: "Hello" }] },
    ],
  });

  await run({
    type: "approval",
    conversationId,
    decisions: [{ approvalId: "approval-1", approved: true }],
    focus: { accountSelection: "all", threadId: null },
  });

  assert.deepEqual(frames, [{ type: "rejected", conversationId, reason: "invalid" }]);
  assert.deepEqual(events, ["start", "release"]);
  assert.deepEqual(toolCalls, []);
  assert.equal(model.doStreamCalls.length, 0);
});

test("ended sessions, busy conversations, and reused message IDs never reach the model", async () => {
  const model = scriptedModel([]);
  const ended = harness({
    model,
    overrides: { getIdentity: async () => null },
  });
  assert.deepEqual(await ended.run(messageFrame), { isSessionEnded: true });
  assert.deepEqual(ended.frames, [
    { type: "rejected", conversationId, reason: "session_ended" },
  ]);
  assert.deepEqual(ended.events, []);

  const busy = harness({
    model,
    overrides: { startRun: async () => ({ outcome: "busy" }) },
  });
  await busy.run(messageFrame);
  assert.deepEqual(busy.frames, [{ type: "rejected", conversationId, reason: "busy" }]);

  const reused = harness({
    model,
    overrides: {
      startRun: async () => {
        throw new AgentMessageConflictError();
      },
    },
  });
  await reused.run(messageFrame);
  assert.deepEqual(reused.frames, [{ type: "rejected", conversationId, reason: "invalid" }]);
  assert.equal(model.doStreamCalls.length, 0);
});

test("a model failure reaches the user as a generic error and the history is kept", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("provider said: internal detail");
    },
  });
  const { run, frames, events } = harness({ model });

  await run(messageFrame);

  const errors = frames.flatMap((frame) =>
    frame.type === "chunk" && frame.chunk.type === "error" ? [frame.chunk.errorText] : [],
  );
  assert.deepEqual(errors, ["The agent could not finish this response."]);
  assert.equal(frames.at(-1)?.type, "end");
  assert.equal(events[0], "start");
  assert.ok(events.includes("save-and-finish") || events.includes("release"));
});

test("conversation titles come from the first message, collapsed and bounded", () => {
  assert.equal(getConversationTitle("  Find   the\nlease  "), "Find the lease");
  const title = getConversationTitle("x".repeat(200));
  assert.equal(title.length, 80);
  assert.ok(title.endsWith("…"));
});
