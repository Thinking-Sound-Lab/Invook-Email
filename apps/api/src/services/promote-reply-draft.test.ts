import assert from "node:assert/strict";
import test from "node:test";

import type { BeginGmailDraftWriteResult } from "@invook/database";

import {
  promoteReplyDraftToGmail,
  type PromoteReplyDraftDependencies,
  type PromoteReplyDraftInput,
} from "./promote-reply-draft";

const input: PromoteReplyDraftInput = {
  userId: "11111111-1111-4111-8111-111111111111",
  access: {
    accountId: "22222222-2222-4222-8222-222222222222",
    accessToken: "access-token",
    email: "owner@example.com",
  },
  draftId: "33333333-3333-4333-8333-333333333333",
  updatedAt: new Date("2026-08-14T10:00:00.000Z"),
  accountEmail: "owner@example.com",
  providerThreadId: "provider-thread",
  subject: "Subject",
  currentText: "Reply body",
  replyTarget: {
    sender: { raw: "Recipient <recipient@example.com>", email: "recipient@example.com" },
    headerLines: [{ key: "message-id", line: "Message-ID: <original@example.com>" }],
  },
};

function gmailDraft() {
  return {
    id: "provider-draft",
    message: {
      id: "provider-message",
      threadId: "provider-thread",
      raw: "",
    },
  };
}

function memoryDependencies(): {
  dependencies: PromoteReplyDraftDependencies;
  counts: { create: number; catchup: number };
} {
  let stored: BeginGmailDraftWriteResult | null = null;
  let storedIdempotencyKey: string | null = null;
  const counts = { create: 0, catchup: 0 };
  const dependencies: PromoteReplyDraftDependencies = {
    beginWrite: async ({ idempotencyKey }) => {
      if (stored) {
        assert.equal(idempotencyKey, storedIdempotencyKey);
        return stored;
      }
      storedIdempotencyKey = idempotencyKey;
      stored = { outcome: "claimed", operationId: "operation-1" };
      return stored;
    },
    completeWrite: async ({ operationId, result }) => {
      stored = { outcome: "complete", operationId, result };
    },
    abandonWrite: async () => {
      stored = null;
    },
    createDraft: async (_accessToken, write) => {
      counts.create += 1;
      assert.equal(write.threadId, "provider-thread");
      const message = write.raw.toString("utf8");
      assert.match(
        message,
        /\r\nMessage-ID: <invook-reply-operation-1@invook\.invalid>\r\n/,
      );
      assert.match(message, /\r\nIn-Reply-To: <original@example\.com>\r\n/);
      return gmailDraft();
    },
    listDrafts: async () => ({ drafts: [] }),
    enqueueCatchup: async ({ sourceId }) => {
      counts.catchup += 1;
      assert.equal(sourceId, "promote-reply-draft:operation-1");
      return "catchup-step";
    },
  };
  return { dependencies, counts };
}

test("a retry promotes one Invook draft version to exactly one Gmail draft", async () => {
  const { dependencies, counts } = memoryDependencies();

  const first = await promoteReplyDraftToGmail(input, dependencies);
  const retry = await promoteReplyDraftToGmail(input, dependencies);

  assert.deepEqual(retry, first);
  assert.equal(counts.create, 1);
  assert.equal(counts.catchup, 2);
});

test("an ambiguous promotion recovers by the stable RFC 822 message ID", async () => {
  let completed = false;
  const dependencies: PromoteReplyDraftDependencies = {
    beginWrite: async () => ({
      outcome: "pending",
      operationId: "operation-1",
      result: null,
    }),
    completeWrite: async () => {
      completed = true;
    },
    abandonWrite: async () => undefined,
    createDraft: async () => {
      throw new Error("create must not repeat");
    },
    listDrafts: async (_accessToken, options) => {
      assert.equal(
        options.query,
        "rfc822msgid:invook-reply-operation-1@invook.invalid",
      );
      return {
        drafts: [
          {
            id: "provider-draft",
            message: { id: "provider-message", threadId: "provider-thread" },
          },
        ],
      };
    },
    enqueueCatchup: async () => "catchup-step",
  };

  const result = await promoteReplyDraftToGmail(input, dependencies);

  assert.equal(completed, true);
  assert.equal(result.draft.providerDraftId, "provider-draft");
});
