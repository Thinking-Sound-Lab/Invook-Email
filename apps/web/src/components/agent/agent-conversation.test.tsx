import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { AgentServerFrame } from "@invook/contracts";

const browserWindow = new Window({ url: "http://localhost/mail" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
  Event: browserWindow.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
browserWindow.HTMLElement.prototype.scrollIntoView = () => {};

const conversationId = "33333333-3333-4333-8333-333333333333";
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});
after(async () => { await browserWindow.happyDOM.close(); });

async function startConversation() {
  const [{ createRoot }, { AgentConversation }, { AgentSocketConnection, AgentSocketTransport }] = await Promise.all([
    import("react-dom/client"),
    import("./agent-conversation"),
    import("@/lib/agent/agent-socket-transport"),
  ]);
  const listeners: Array<{ type: string; listener: unknown }> = [];
  const sent: unknown[] = [];
  const connection = new AgentSocketConnection({
    createTicket: async () => ({
      ticket: "test-ticket",
      socketUrl: "ws://localhost/v1/agent/socket",
      expiresAt: "2026-10-19T09:01:00.000Z",
    }),
    createSocket: () => {
      queueMicrotask(() => {
        for (const entry of [...listeners]) {
          if (entry.type === "open" && typeof entry.listener === "function") entry.listener();
        }
      });
      return {
        readyState: 1,
        send: (data) => { sent.push(JSON.parse(data)); },
        close: () => {},
        addEventListener: (type, listener) => { listeners.push({ type, listener }); },
        removeEventListener: (type, listener) => {
          const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
          if (index !== -1) listeners.splice(index, 1);
        },
      };
    },
  });
  const transport = new AgentSocketTransport(connection, { accountSelection: "all", threadId: null });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const currentRoot = root;
  await act(async () => {
    currentRoot.render(
      <AgentConversation
        conversationId={conversationId}
        initialMessages={[]}
        transport={transport}
        accountSelection="all"
      />,
    );
  });
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(textarea && setter);
  await act(async () => {
    setter.call(textarea, "Who are you?");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(sent.length, 1);

  const receive = async (frame: AgentServerFrame) => {
    await act(async () => {
      for (const entry of listeners) {
        if (entry.type === "message" && typeof entry.listener === "function") {
          entry.listener({ data: JSON.stringify(frame) });
        }
      }
    });
  };
  return { receive, sent };
}

test("the pane displays socket text deltas before the turn ends", async () => {
  const { receive } = await startConversation();
  await receive({ type: "chunk", conversationId, chunk: { type: "start", messageId: "assistant" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "start-step" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "text-start", id: "text" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "text-delta", id: "text", delta: "I’m " } });

  assert.ok(document.body.textContent?.includes("I’m "));
  assert.ok(document.querySelector('[aria-label="Stop the agent"]'));

  await receive({ type: "chunk", conversationId, chunk: { type: "text-delta", id: "text", delta: "Invook." } });
  assert.ok(document.body.textContent?.includes("I’m Invook."));
  assert.ok(document.querySelector('[aria-label="Stop the agent"]'));

  await receive({ type: "chunk", conversationId, chunk: { type: "text-end", id: "text" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "finish-step" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "finish", finishReason: "stop" } });
  await receive({ type: "end", conversationId });

  assert.ok(document.body.textContent?.includes("I’m Invook."));
  assert.equal(document.querySelector('[aria-label="Stop the agent"]'), null);
});

test("the pane keeps progress visible until response content arrives", async () => {
  const { receive } = await startConversation();
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Working…");

  await receive({ type: "chunk", conversationId, chunk: { type: "start", messageId: "assistant" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "start-step" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "text-start", id: "text" } });

  assert.equal(document.querySelector('[role="status"]')?.textContent, "Working…");

  await receive({ type: "chunk", conversationId, chunk: { type: "text-delta", id: "text", delta: "I’m Invook." } });
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Responding…");

  await receive({ type: "chunk", conversationId, chunk: { type: "text-end", id: "text" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "finish-step" } });
  await receive({ type: "chunk", conversationId, chunk: { type: "finish", finishReason: "stop" } });
  await receive({ type: "end", conversationId });

  assert.equal(document.querySelector('[role="status"]'), null);
});
