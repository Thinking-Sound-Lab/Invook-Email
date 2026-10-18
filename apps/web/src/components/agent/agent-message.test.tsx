import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import axios, { type InternalAxiosRequestConfig } from "axios";
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

async function renderMessage(
  message: InvookAgentUIMessage,
  input: {
    canDecide?: boolean;
    onDecide?: (decision: AgentApprovalDecision) => void;
    canRetry?: boolean;
    onRetry?: () => void;
  } = {},
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
          canRetry={input.canRetry ?? true}
          onRetry={input.onRetry ?? (() => {})}
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

const forwardedMessageId = "44444444-4444-4444-8444-444444444444";
const forward: AgentEmailInput = {
  ...email,
  subject: "Fwd: Contract",
  body: "See below.",
  replyToMessageId: null,
  forwardOfMessageId: forwardedMessageId,
};

function pendingForward(): InvookAgentUIMessage {
  return {
    id: "assistant",
    role: "assistant",
    parts: [{
      type: "tool-sendEmail",
      toolCallId: "call-1",
      state: "approval-requested",
      input: forward,
      approval: { id: "approval-1" },
    }],
  };
}

test("a forward cannot be approved until the forwarded message is shown", async () => {
  const requests: InternalAxiosRequestConfig[] = [];
  let respond: (text: string) => void = () => {};
  axios.defaults.adapter = async (config) => {
    requests.push(config);
    const text = await new Promise<string>((resolve) => {
      respond = resolve;
    });
    return { data: { text }, status: 200, statusText: "OK", headers: {}, config };
  };
  await renderMessage(pendingForward());

  assert.equal(findButton("Send")?.disabled, true);
  assert.equal(findButton("Don’t send")?.disabled, false);
  assert.equal(
    requests[0]?.url,
    `/v1/gmail/messages/${forwardedMessageId}/forwarded-text`,
  );
  assert.deepEqual(requests[0]?.params, { account: accountId });

  await act(async () => respond("---------- Forwarded message ---------\nSigned copy attached."));

  const preview = document.querySelector('[aria-label="Forwarded message"]');
  assert.ok(preview?.textContent?.includes("Signed copy attached."));
  assert.equal(findButton("Send")?.disabled, false);
});

test("a forward whose original cannot be loaded cannot be approved until it loads", async () => {
  let attempts = 0;
  axios.defaults.adapter = async (config) => {
    attempts += 1;
    if (attempts === 1) {
      throw new axios.AxiosError("Unavailable", "ERR_BAD_RESPONSE", config);
    }
    return { data: { text: "Signed copy attached." }, status: 200, statusText: "OK", headers: {}, config };
  };
  await renderMessage(pendingForward());
  await act(async () => {});

  assert.ok(document.body.textContent?.includes("could not be loaded"));
  assert.equal(findButton("Send")?.disabled, true);

  await act(async () => findButton("Try again")?.click());

  assert.equal(attempts, 2);
  assert.ok(
    document.querySelector('[aria-label="Forwarded message"]')?.textContent?.includes(
      "Signed copy attached.",
    ),
  );
  assert.equal(findButton("Send")?.disabled, false);
});

test("an interrupted approval offers a retry, and a send left behind says it was not sent", async () => {
  let retries = 0;
  await renderMessage(
    {
      id: "assistant",
      role: "assistant",
      parts: [
        {
          type: "tool-sendEmail",
          toolCallId: "call-1",
          state: "approval-responded",
          input: email,
          approval: { id: "approval-1", approved: true },
        },
        {
          type: "tool-sendEmail",
          toolCallId: "call-2",
          state: "output-denied",
          input: email,
          approval: {
            id: "approval-2",
            approved: false,
            reason: "Not approved before the next message.",
          },
        },
      ],
    },
    { onRetry: () => (retries += 1) },
  );

  const text = document.body.textContent ?? "";
  assert.ok(text.includes("Sending did not finish."));
  assert.ok(text.includes("Not sent. Not approved before the next message."));
  await act(async () => findButton("Retry")?.click());
  assert.equal(retries, 1);
});

test("an interrupted approval in an earlier message offers no retry", async () => {
  await renderMessage(
    {
      id: "assistant",
      role: "assistant",
      parts: [{
        type: "tool-sendEmail",
        toolCallId: "call-1",
        state: "approval-responded",
        input: email,
        approval: { id: "approval-1", approved: true },
      }],
    },
    { canRetry: false },
  );

  assert.ok(document.body.textContent?.includes("Sending did not finish."));
  assert.equal(findButton("Retry"), undefined);
});
