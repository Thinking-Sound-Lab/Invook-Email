import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { AgentConversationResponse } from "@invook/contracts";

import type { UseAgentConversationSelectionResult } from "./use-agent-conversation-selection";

const browserWindow = new Window({ url: "http://localhost/mail" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

const deletedId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

type PendingRead = {
  url: string;
  respond: (conversationId: string) => void;
};

let root: Root | null = null;
const originalAdapter = axios.defaults.adapter;

afterEach(async () => {
  axios.defaults.adapter = originalAdapter;
  const currentRoot = root;
  root = null;
  if (currentRoot) await act(async () => currentRoot.unmount());
  document.body.innerHTML = "";
});

after(async () => {
  await browserWindow.happyDOM.close();
});

function conversationResponse(conversationId: string): AgentConversationResponse {
  return {
    conversation: {
      id: conversationId,
      title: "Find the lease",
      updatedAt: "2026-10-18T09:00:00.000Z",
    },
    messages: [
      { id: "33333333-3333-4333-8333-333333333333", role: "user", parts: [{ type: "text", text: "Find the lease" }] },
    ],
  };
}

/** Holds every conversation read open until the test answers it. */
function holdReads(): PendingRead[] {
  const reads: PendingRead[] = [];
  axios.defaults.adapter = (config: InternalAxiosRequestConfig) =>
    new Promise<AxiosResponse>((resolve) => {
      reads.push({
        url: config.url ?? "",
        respond: (conversationId) =>
          resolve({
            data: conversationResponse(conversationId),
            status: 200,
            statusText: "OK",
            headers: {},
            config,
          }),
      });
    });
  return reads;
}

async function renderSelection(): Promise<{ current: () => UseAgentConversationSelectionResult }> {
  const [{ createRoot }, { useAgentConversationSelection }] = await Promise.all([
    import("react-dom/client"),
    import("./use-agent-conversation-selection"),
  ]);
  let latest: UseAgentConversationSelectionResult | null = null;
  function Probe() {
    latest = useAgentConversationSelection();
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const currentRoot = root;
  await act(async () => currentRoot.render(createElement(Probe)));
  return {
    current: () => {
      assert.ok(latest);
      return latest;
    },
  };
}

test("a conversation deleted while it loads is not reopened", async () => {
  const reads = holdReads();
  const selection = await renderSelection();
  const startingId = selection.current().conversation.conversationId;

  let opening: Promise<boolean> = Promise.resolve(true);
  await act(async () => {
    opening = selection.current().openConversation(deletedId);
  });
  assert.equal(selection.current().loadingConversationId, deletedId);

  await act(async () => selection.current().markConversationDeleted(deletedId));
  await act(async () => reads[0]?.respond(deletedId));

  assert.equal(await opening, false);
  assert.equal(selection.current().loadingConversationId, null);
  assert.equal(selection.current().conversation.conversationId, startingId);
  assert.deepEqual(selection.current().conversation.initialMessages, []);
});

test("only the newest choice opens, and deleting another conversation keeps it open", async () => {
  const reads = holdReads();
  const selection = await renderSelection();

  let first: Promise<boolean> = Promise.resolve(true);
  let second: Promise<boolean> = Promise.resolve(false);
  await act(async () => {
    first = selection.current().openConversation(deletedId);
  });
  await act(async () => {
    second = selection.current().openConversation(otherId);
  });
  await act(async () => reads[1]?.respond(otherId));
  await act(async () => reads[0]?.respond(deletedId));

  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(selection.current().conversation.conversationId, otherId);
  assert.equal(selection.current().conversation.initialMessages.length, 1);

  await act(async () => selection.current().markConversationDeleted(deletedId));
  assert.equal(selection.current().conversation.conversationId, otherId);

  await act(async () => selection.current().markConversationDeleted(otherId));
  assert.notEqual(selection.current().conversation.conversationId, otherId);
  assert.deepEqual(selection.current().conversation.initialMessages, []);
});
