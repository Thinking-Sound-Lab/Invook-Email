import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentEmailInput,
  GmailComposeDraftResponse,
  GmailComposeSendResponse,
} from "@invook/contracts";
import { GmailApiError } from "@invook/gmail";

import {
  createAgentCapabilities,
  splitAddressList,
  type AgentCapabilityDependencies,
} from "./agent-capabilities";
import { GmailDraftChangedError } from "./compose-send";
import type { SaveComposeDraftInput } from "./compose-drafts";
import type { SendComposeDraftInput } from "./compose-send";

const userId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const replyMessageId = "44444444-4444-4444-8444-444444444444";
const access = { accountId, accessToken: "access-token", email: "owner@example.com" };
const scope = { userId, writeScopeId: conversationId, ensureRunActive: async () => true };
const email: AgentEmailInput = {
  accountId,
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Contract",
  body: "The signed contract is ready.",
  replyToMessageId: null,
  forwardOfMessageId: null,
  draftId: null,
};

function fakeDependencies(overrides: Partial<AgentCapabilityDependencies> = {}) {
  const saved: SaveComposeDraftInput[] = [];
  const sent: SendComposeDraftInput[] = [];
  const reconnects: string[] = [];
  const dependencies: AgentCapabilityDependencies = {
    searchMail: async () => [],
    getThreadDetail: async () => null,
    getReplyContext: async () => null,
    getProviderAccess: async (input) =>
      input.userId === userId && input.accountId === accountId
        ? { status: "ready", access }
        : { status: "not_found", access: null },
    saveDraft: async (input): Promise<GmailComposeDraftResponse> => {
      saved.push(input);
      return {
        draft: {
          providerDraftId: input.providerDraftId ?? "provider-draft",
          providerMessageId: "provider-message",
          providerThreadId: "provider-thread",
        },
        stepId: "step",
      };
    },
    sendDraft: async (input): Promise<GmailComposeSendResponse> => {
      sent.push(input);
      return {
        message: {
          providerMessageId: "sent-message",
          providerThreadId: "provider-thread",
        },
        stepId: "step",
      };
    },
    markReconnectRequired: async ({ accountId: markedAccountId }) => {
      reconnects.push(markedAccountId);
      return true;
    },
    ...overrides,
  };
  return { dependencies, saved, sent, reconnects };
}

test("a draft is written for the scoped user with a key stable per tool call", async () => {
  const { dependencies, saved } = fakeDependencies();
  const capabilities = createAgentCapabilities(scope, dependencies);

  const first = await capabilities.saveDraft(email, { toolCallId: "call-1" });
  await capabilities.saveDraft(email, { toolCallId: "call-1" });
  await capabilities.saveDraft(email, { toolCallId: "call-2" });

  assert.deepEqual(first, {
    status: "saved",
    accountId,
    providerDraftId: "provider-draft",
    providerThreadId: "provider-thread",
  });
  assert.equal(saved[0]?.userId, userId);
  assert.equal(saved[0]?.operation, "create");
  assert.equal(saved[0]?.idempotencyKey, saved[1]?.idempotencyKey);
  assert.notEqual(saved[0]?.idempotencyKey, saved[2]?.idempotencyKey);
  assert.deepEqual(saved[0]?.fields, {
    recipients: ["recipient@example.com"],
    ccRecipients: [],
    bccRecipients: [],
    subject: "Contract",
    body: "The signed contract is ready.",
  });
});

test("revising a saved draft updates it instead of creating another", async () => {
  const { dependencies, saved } = fakeDependencies();
  const capabilities = createAgentCapabilities(scope, dependencies);

  await capabilities.saveDraft({ ...email, draftId: "r-123" }, { toolCallId: "call-1" });

  assert.equal(saved[0]?.operation, "update");
  assert.equal(saved[0]?.providerDraftId, "r-123");
});

test("sending writes the approved content to the draft, then sends that draft", async () => {
  const { dependencies, saved, sent } = fakeDependencies();
  const capabilities = createAgentCapabilities(scope, dependencies);

  const result = await capabilities.sendEmail(
    { ...email, draftId: "r-123" },
    { toolCallId: "call-send" },
  );
  const retried = await capabilities.sendEmail(
    { ...email, draftId: "r-123" },
    { toolCallId: "call-send" },
  );

  assert.deepEqual(result, {
    status: "sent",
    accountId,
    providerMessageId: "sent-message",
    providerThreadId: "provider-thread",
  });
  assert.deepEqual(retried, result);
  assert.equal(saved[0]?.operation, "update");
  assert.deepEqual(saved[0]?.fields.body, email.body);
  assert.equal(sent[0]?.providerDraftId, "r-123");
  assert.equal(sent[0]?.userId, userId);
  // A re-approved or retried call reuses both Gmail write keys.
  assert.equal(sent[0]?.idempotencyKey, sent[1]?.idempotencyKey);
  assert.equal(saved[0]?.idempotencyKey, saved[1]?.idempotencyKey);
  assert.notEqual(saved[0]?.idempotencyKey, sent[0]?.idempotencyKey);
});

test("model-chosen identifiers outside the user's scope fail without a Gmail write", async () => {
  const { dependencies, saved, sent } = fakeDependencies();
  const capabilities = createAgentCapabilities(scope, dependencies);

  const results = await Promise.all([
    capabilities.saveDraft(
      { ...email, accountId: "55555555-5555-4555-8555-555555555555" },
      { toolCallId: "call-1" },
    ),
    capabilities.saveDraft({ ...email, accountId: "work" }, { toolCallId: "call-2" }),
    capabilities.saveDraft(
      { ...email, replyToMessageId: "message" },
      { toolCallId: "call-3" },
    ),
    capabilities.saveDraft(
      { ...email, replyToMessageId: replyMessageId, forwardOfMessageId: replyMessageId },
      { toolCallId: "call-4" },
    ),
    capabilities.sendEmail({ ...email, draftId: "../draft" }, { toolCallId: "call-5" }),
    capabilities.sendEmail({ ...email, to: ["Recipient"] }, { toolCallId: "call-6" }),
  ]);

  assert.deepEqual(
    results.map((result) => result.status === "failed" && result.reason),
    [
      "That Gmail account is not connected to Invook.",
      "That Gmail account is not connected to Invook.",
      "That message is not available in this account.",
      "An email can reply or forward, not both.",
      "That draft is not available.",
      "Enter valid email addresses separated by commas.",
    ],
  );
  assert.deepEqual(saved, []);
  assert.deepEqual(sent, []);
});

test("a reply shows the subject Gmail threading will actually use", async () => {
  const { dependencies } = fakeDependencies({
    getReplyContext: async (input) =>
      input.userId === userId && input.messageId === replyMessageId
        ? { providerThreadId: "provider-thread", subject: "Signed contract", headerLines: [] }
        : null,
  });
  const capabilities = createAgentCapabilities(scope, dependencies);

  assert.equal(
    (await capabilities.resolveEmail({ ...email, replyToMessageId: replyMessageId })).subject,
    "Re: Signed contract",
  );
  assert.equal((await capabilities.resolveEmail(email)).subject, "Contract");
});

test("provider failures become plain reasons and expired grants require reconnecting", async () => {
  const revoked = new GmailApiError("Unauthorized", 401, "");
  const { dependencies, reconnects } = fakeDependencies({
    sendDraft: async () => {
      throw revoked;
    },
  });
  const capabilities = createAgentCapabilities(scope, dependencies);

  assert.deepEqual(await capabilities.sendEmail(email, { toolCallId: "call-1" }), {
    status: "failed",
    reason: "That Gmail account must be reconnected in Invook first.",
  });
  assert.deepEqual(reconnects, [accountId]);

  const unavailable = createAgentCapabilities(
    scope,
    fakeDependencies({
      saveDraft: async () => {
        throw new GmailApiError("Backend Error", 503, "");
      },
    }).dependencies,
  );
  assert.deepEqual(await unavailable.saveDraft(email, { toolCallId: "call-2" }), {
    status: "failed",
    reason: "Gmail is unavailable right now. Try again shortly.",
  });

  const unexpected = createAgentCapabilities(
    scope,
    fakeDependencies({
      saveDraft: async () => {
        throw new Error("connection string postgres://secret@host");
      },
    }).dependencies,
  );
  assert.deepEqual(await unexpected.saveDraft(email, { toolCallId: "call-3" }), {
    status: "failed",
    reason: "Invook could not complete this request.",
  });
});

test("search and thread reads are scoped, bounded, and honest about bad input", async () => {
  const searchCalls: unknown[] = [];
  const { dependencies } = fakeDependencies({
    searchMail: async (input) => {
      searchCalls.push(input);
      return [{
        accountId,
        messageId: replyMessageId,
        threadId: conversationId,
        subject: "Invoice",
        snippet: "snippet",
        bodyPreview: `Line one\n\nline two ${"x".repeat(500)}`,
        sender: { raw: "Billing <billing@example.com>", email: "billing@example.com" },
        sentAt: "2026-10-17T09:00:00.000Z",
        attachments: [{
          id: "attachment",
          messageId: replyMessageId,
          providerAttachmentId: null,
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 10,
          contentId: null,
          contentDisposition: null,
          checksumSha256: null,
          contentLength: null,
        }],
        matches: ["attachment"],
        score: 0.9,
      }];
    },
  });
  const capabilities = createAgentCapabilities(scope, dependencies);

  const result = await capabilities.searchMail({ query: " invoice ", accountId: null });

  assert.deepEqual(searchCalls, [
    { userId, accountId: null, query: "invoice", limit: 10 },
  ]);
  assert.ok(result.status === "available");
  assert.equal(result.results[0]?.sender, "Billing <billing@example.com>");
  assert.deepEqual(result.results[0]?.attachmentFilenames, ["invoice.pdf"]);
  assert.ok(result.results[0]?.preview.startsWith("Line one line two"));
  assert.ok((result.results[0]?.preview.length ?? 0) <= 401);
  assert.deepEqual(await capabilities.searchMail({ query: "x", accountId: "work" }), {
    status: "failed",
    reason: "That Gmail account is not connected to Invook.",
  });
  assert.deepEqual(await capabilities.readThread({ threadId: "thread" }), {
    status: "unavailable",
  });
});

test("address headers split on commas outside quoted names", () => {
  assert.deepEqual(
    splitAddressList('"Doe, Jane" <jane@example.com>, bob@example.com,  <a,b@example.com>'),
    ['"Doe, Jane" <jane@example.com>', "bob@example.com", "<a,b@example.com>"],
  );
});

test("a send is bound to the approved draft message and refused if it changed", async () => {
  const { dependencies, sent } = fakeDependencies();
  const capabilities = createAgentCapabilities(scope, dependencies);

  await capabilities.sendEmail(email, { toolCallId: "call-1" });
  assert.equal(sent[0]?.expectedProviderMessageId, "provider-message");

  const changed = createAgentCapabilities(
    scope,
    fakeDependencies({
      sendDraft: async () => {
        throw new GmailDraftChangedError();
      },
    }).dependencies,
  );
  assert.deepEqual(await changed.sendEmail(email, { toolCallId: "call-2" }), {
    status: "failed",
    reason: "The draft changed after you approved it, so it was not sent.",
  });
});

test("a turn that lost its conversation makes no Gmail write", async () => {
  const { dependencies, saved, sent } = fakeDependencies();
  const capabilities = createAgentCapabilities(
    { ...scope, ensureRunActive: async () => false },
    dependencies,
  );
  const superseded = {
    status: "failed",
    reason:
      "This conversation continued elsewhere, so Invook stopped before changing Gmail.",
  };

  assert.deepEqual(await capabilities.saveDraft(email, { toolCallId: "call-1" }), superseded);
  assert.deepEqual(await capabilities.sendEmail(email, { toolCallId: "call-2" }), superseded);
  assert.deepEqual(saved, []);
  assert.deepEqual(sent, []);

  // Ownership lost between writing the draft and sending it stops the send.
  let checks = 0;
  const lostMidway = fakeDependencies();
  const midway = createAgentCapabilities(
    { ...scope, ensureRunActive: async () => (checks += 1) === 1 },
    lostMidway.dependencies,
  );
  assert.deepEqual(await midway.sendEmail(email, { toolCallId: "call-3" }), superseded);
  assert.equal(lostMidway.saved.length, 1);
  assert.deepEqual(lostMidway.sent, []);
});
