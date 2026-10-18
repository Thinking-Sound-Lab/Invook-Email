import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  AgentApprovalDecision,
  AgentEmailInput,
  InvookAgentUIMessage,
  MailboxShell,
} from "@invook/contracts";

const browserWindow = new Window({ url: "http://localhost/mail" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  Event: browserWindow.Event,
  MouseEvent: browserWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

const accountId = "22222222-2222-4222-8222-222222222222";
const shell: MailboxShell = {
  aiConfigured: true,
  user: { name: "Owner", email: "owner@example.com", image: null },
  accounts: [{
    id: accountId,
    email: "owner@example.com",
    image: null,
    status: "connected",
    syncState: { mailSync: "complete" },
    lastSyncedAt: "2026-10-18T00:00:00.000Z",
    replica: { state: "ready", readyAt: "2026-10-18T00:00:00.000Z" },
  }],
  accountLabels: [],
};
const email: AgentEmailInput = {
  accountId,
  to: ["recipient@example.com"],
  cc: ["copy@example.com"],
  bcc: [],
  subject: "Re: Contract",
  body: "Signed and returned.",
  replyToMessageId: "33333333-3333-4333-8333-333333333333",
  forwardOfMessageId: null,
  draftId: null,
};

let root: Root | null = null;

afterEach(async () => {
  const currentRoot = root;
  root = null;
  if (currentRoot) await act(async () => currentRoot.unmount());
  document.body.innerHTML = "";
});

after(async () => {
  await browserWindow.happyDOM.close();
});

async function renderMessage(
  message: InvookAgentUIMessage,
  input: { canDecide?: boolean; onDecide?: (decision: AgentApprovalDecision) => void } = {},
): Promise<void> {
  const [{ createRoot }, { MailShellProvider }, { AgentMessage }] = await Promise.all([
    import("react-dom/client"),
    import("@/components/mail/mail-shell-provider"),
    import("./agent-message"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const currentRoot = root;
  await act(async () => {
    currentRoot.render(
      <MailShellProvider shell={shell}>
        <AgentMessage
          message={message}
          accountSelection="all"
          canDecide={input.canDecide ?? true}
          onDecide={input.onDecide ?? (() => {})}
        />
      </MailShellProvider>,
    );
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

test("the approval card shows the exact email and records the user's decision", async () => {
  const decisions: AgentApprovalDecision[] = [];
  await renderMessage(
    {
      id: "assistant",
      role: "assistant",
      parts: [{
        type: "tool-sendEmail",
        toolCallId: "call-1",
        state: "approval-requested",
        input: email,
        approval: { id: "approval-1" },
      }],
    },
    { onDecide: (decision) => decisions.push(decision) },
  );

  const card = document.querySelector('[aria-label="Email waiting for your approval"]');
  assert.ok(card);
  for (const text of [
    "owner@example.com",
    "recipient@example.com",
    "copy@example.com",
    "Re: Contract",
    "Signed and returned.",
    "Nothing is sent until you approve it.",
  ]) {
    assert.ok(card.textContent?.includes(text), `Missing ${text}`);
  }
  assert.equal(card.textContent?.includes("Bcc"), false);

  await act(async () => findButton("Send")?.click());
  await act(async () => findButton("Don’t send")?.click());

  assert.deepEqual(decisions, [
    { approvalId: "approval-1", approved: true },
    { approvalId: "approval-1", approved: false },
  ]);
});

test("a decision cannot be made while the agent is still working", async () => {
  await renderMessage(
    {
      id: "assistant",
      role: "assistant",
      parts: [{
        type: "tool-sendEmail",
        toolCallId: "call-1",
        state: "approval-requested",
        input: email,
        approval: { id: "approval-1" },
      }],
    },
    { canDecide: false },
  );

  assert.equal(findButton("Send")?.disabled, true);
  assert.equal(findButton("Don’t send")?.disabled, true);
});

test("sent, declined, and failed sends say plainly what happened", async () => {
  await renderMessage({
    id: "assistant",
    role: "assistant",
    parts: [
      {
        type: "tool-sendEmail",
        toolCallId: "call-1",
        state: "output-available",
        input: email,
        output: {
          status: "sent",
          accountId,
          providerMessageId: "message",
          providerThreadId: "thread",
        },
      },
      {
        type: "tool-sendEmail",
        toolCallId: "call-2",
        state: "output-denied",
        input: email,
        approval: { id: "approval-2", approved: false },
      },
      {
        type: "tool-sendEmail",
        toolCallId: "call-3",
        state: "output-available",
        input: email,
        output: { status: "failed", reason: "Gmail rejected this email." },
      },
    ],
  });

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("Sent"));
  assert.ok(text.includes("You chose not to send this email."));
  assert.ok(text.includes("Not sent. Gmail rejected this email."));
  // A failed send still shows which email was not sent.
  assert.ok(
    document.querySelector('[aria-label="Email not sent"]')?.textContent?.includes(
      "Signed and returned.",
    ),
  );
  assert.equal(findButton("Send"), undefined);
});

test("a saved draft links to Drafts for its account", async () => {
  await renderMessage({
    id: "assistant",
    role: "assistant",
    parts: [{
      type: "tool-saveDraft",
      toolCallId: "call-1",
      state: "output-available",
      input: email,
      output: {
        status: "saved",
        accountId,
        providerDraftId: "draft",
        providerThreadId: "thread",
      },
    }],
  });

  assert.ok(document.body.textContent?.includes("Draft saved in Gmail"));
  const link = [...document.querySelectorAll("a")].find(
    (anchor) => anchor.textContent === "Open Drafts",
  );
  assert.equal(link?.getAttribute("href"), `/mail?account=${accountId}&view=drafts`);
});
