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
  onFrame?: (frame: AgentServerFrame) => void;
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
      assert.equal(scope.userId, userId);
      assert.equal(scope.writeScopeId, conversationId);
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
        send: (serverFrame) => {
          frames.push(serverFrame);
          input.onFrame?.(serverFrame);
        },
      },
      dependencies,
    );
  return { run, frames, events, savedMessages, toolCalls };
}

const messageFrame: Extract<AgentTurnFrame, { type: "message" }> = {
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

  assert.deepEqual(events, ["start", "save-and-finish"]);
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
  const prompt = model.doStreamCalls[0]?.prompt;
  const system = prompt?.find((message) => message.role === "system");
  assert.match(String(system?.content), /You are Invook/);
  assert.ok(!String(system?.content).includes(threadId));
  const context = prompt?.[1];
  assert.ok(context?.role === "user");
  const content = context.content[0];
  assert.ok(content?.type === "text");
  assert.ok(content.text.includes(JSON.stringify(openThread)));
  assert.ok(!JSON.stringify(savedMessages).includes('"openThread"'));
});

test("text deltas are sent while the model stream is still open", async () => {
  let modelStream: ReadableStreamDefaultController<StreamPart> | undefined;
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start: (controller) => {
          modelStream = controller;
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({ type: "text-delta", id: "text-1", delta: "First words" });
        },
      }),
    }),
  });
  let resolveFirstDelta: () => void = () => {};
  const firstDelta = new Promise<void>((resolve) => { resolveFirstDelta = resolve; });
  const active = harness({ model, onFrame: (frame) => {
    if (frame.type === "chunk" && frame.chunk.type === "text-delta") resolveFirstDelta();
  } });

  const completion = active.run(messageFrame);
  await firstDelta;

  assert.equal(active.savedMessages.length, 0);
  assert.ok(!active.frames.some((frame) => frame.type === "end"));
  assert.ok(modelStream);
  modelStream.enqueue({ type: "text-delta", id: "text-1", delta: " arrive now." });
  modelStream.enqueue({ type: "text-end", id: "text-1" });
  modelStream.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
  modelStream.close();
  await completion;

  assert.equal(active.frames.at(-1)?.type, "end");
  assert.equal(active.savedMessages.length, 1);
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

  // The decision is stored before the send runs, then the result with the
  // turn's response.
  assert.deepEqual(second.events, ["start", "save", "save-and-finish"]);
  assert.equal(partState(second.savedMessages[0]?.messages[0]), "approval-responded");
  assert.deepEqual(second.toolCalls, [
    { name: "sendEmail", input: email, toolCallId: "call-sendEmail" },
  ]);
  // The continuation extends the same assistant message.
  assert.equal(second.savedMessages[1]?.messages[0]?.id, stored.id);
  assert.equal(partState(second.savedMessages[1]?.messages[0]), "output-available");
});

function partState(message: StoredAgentMessage | undefined): unknown {
  const part = message?.parts.find(
    (candidate) =>
      typeof candidate === "object" && candidate !== null && "approval" in candidate,
  );
  return part && typeof part === "object" && "state" in part ? part.state : undefined;
}

function pendingSendHistory(
  state: "approval-requested" | "approval-responded",
): StoredAgentMessage[] {
  return [
    { id: messageId, role: "user", parts: [{ type: "text", text: messageFrame.text }] },
    {
      id: "assistant-message",
      role: "assistant",
      parts: [{
        type: "tool-sendEmail",
        toolCallId: "call-sendEmail",
        state,
        input: email,
        approval: state === "approval-requested"
          ? { id: "approval-1" }
          : { id: "approval-1", approved: true },
      }],
    },
  ];
}

const approveFrame: AgentTurnFrame = {
  type: "approval",
  conversationId,
  decisions: [{ approvalId: "approval-1", approved: true }],
  focus: { accountSelection: "all", threadId: null },
};

test("a turn that fails after an approval keeps the decision to resume", async () => {
  const failed = harness({
    model: scriptedModel([]),
    history: pendingSendHistory("approval-requested"),
    overrides: {
      listAccounts: async () => {
        throw new Error("database unavailable");
      },
    },
  });

  await failed.run(approveFrame);

  assert.deepEqual(failed.frames, [
    { type: "rejected", conversationId, reason: "unavailable" },
  ]);
  // The decision is on record, so a later message cannot settle an email
  // that may have been sent as declined; resending the decision resumes it.
  assert.deepEqual(failed.events, ["start", "save", "release"]);
  assert.equal(partState(failed.savedMessages[0]?.messages[0]), "approval-responded");
  assert.deepEqual(failed.toolCalls, []);
});

test("an approval whose conversation was taken over never runs the tool", async () => {
  const superseded = harness({
    model: scriptedModel([]),
    history: pendingSendHistory("approval-requested"),
    overrides: {
      saveRunMessages: async () => ({ saved: false }),
    },
  });

  await superseded.run(approveFrame);

  assert.deepEqual(superseded.frames, [
    { type: "rejected", conversationId, reason: "busy" },
  ]);
  assert.deepEqual(superseded.events, ["start", "release"]);
  assert.deepEqual(superseded.toolCalls, []);
});

test("an interrupted approved send resumes under its original tool call", async () => {
  const resumed = harness({
    model: scriptedModel([textResponse("Sent.")]),
    history: pendingSendHistory("approval-responded"),
  });

  await resumed.run(approveFrame);

  assert.deepEqual(resumed.toolCalls, [
    { name: "sendEmail", input: email, toolCallId: "call-sendEmail" },
  ]);

  // A stored approval can be resumed, never reversed.
  const reversed = harness({
    model: scriptedModel([]),
    history: pendingSendHistory("approval-responded"),
  });
  await reversed.run({
    ...approveFrame,
    decisions: [{ approvalId: "approval-1", approved: false }],
  });
  assert.deepEqual(reversed.frames, [
    { type: "rejected", conversationId, reason: "invalid" },
  ]);
  assert.deepEqual(reversed.toolCalls, []);
});

test("a new message settles an approval left open before it", async () => {
  const followUp = harness({
    model: scriptedModel([textResponse("I did not send it.")]),
    history: pendingSendHistory("approval-requested"),
  });

  await followUp.run({
    ...messageFrame,
    messageId: "66666666-6666-4666-8666-666666666666",
    text: "Actually, change the subject first.",
  });

  assert.deepEqual(followUp.events, ["start", "save", "save-and-finish"]);
  assert.equal(followUp.savedMessages[0]?.messages[0]?.id, "assistant-message");
  assert.equal(partState(followUp.savedMessages[0]?.messages[0]), "output-denied");
  assert.deepEqual(followUp.toolCalls.map((call) => call.name), ["readThread"]);
});

test("a turn that loses its conversation stops before another model step", async () => {
  const model = scriptedModel([
    toolCallResponse("searchMail", { query: "invoice", accountId: null }),
    textResponse("Found nothing."),
  ]);
  const superseded = harness({
    model,
    overrides: { renewRun: async () => false },
  });

  await superseded.run(messageFrame);

  assert.equal(model.doStreamCalls.length, 1);
  assert.equal(superseded.frames.at(-1)?.type, "end");
});

test("a turn that still owns its conversation renews it and keeps working after a tool", async () => {
  const model = scriptedModel([
    toolCallResponse("searchMail", { query: "invoice", accountId: null }),
    textResponse("Found nothing."),
  ]);
  const active = harness({ model });

  await active.run(messageFrame);

  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(active.events, ["start", "renew", "save-and-finish"]);
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
