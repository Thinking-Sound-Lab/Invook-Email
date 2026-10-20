import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGmailThreadAction,
  type GmailThreadActionDependencies,
} from "./gmail-thread-actions";

const userId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const access = {
  accessToken: "access-token",
  accountId,
  email: "owner@example.com",
};

test("an owned thread is marked read with one provider write and one catch-up", async () => {
  const providerWrites: unknown[][] = [];
  const catchups: unknown[] = [];
  const dependencies: GmailThreadActionDependencies = {
    modifyThreadLabels: async (...input) => {
      providerWrites.push(input);
    },
    enqueueHistoryCatchup: async (input) => {
      catchups.push(input);
      return "catchup-step";
    },
  };

  const result = await applyGmailThreadAction(
    {
      access,
      context: {
        accountId,
        providerThreadId: "provider-thread",
      },
      action: "mark_read",
      userId,
    },
    dependencies,
  );

  assert.deepEqual(providerWrites, [
    ["access-token", "provider-thread", { removeLabelIds: ["UNREAD"] }],
  ]);
  assert.deepEqual(catchups, [
    { userId, accountId, reason: "provider_write" },
  ]);
  assert.deepEqual(result, { status: "complete", stepId: "catchup-step" });
});

test("an unowned thread never reaches Gmail or the catch-up workflow", async () => {
  let providerWriteCount = 0;
  let catchupCount = 0;
  const dependencies: GmailThreadActionDependencies = {
    modifyThreadLabels: async () => {
      providerWriteCount += 1;
    },
    enqueueHistoryCatchup: async () => {
      catchupCount += 1;
      return "unexpected-step";
    },
  };

  const result = await applyGmailThreadAction(
    {
      access,
      context: {
        accountId: "33333333-3333-4333-8333-333333333333",
        providerThreadId: "other-provider-thread",
      },
      action: "mark_read",
      userId,
    },
    dependencies,
  );

  assert.deepEqual(result, { status: "not_found" });
  assert.equal(providerWriteCount, 0);
  assert.equal(catchupCount, 0);
});

test("marking a thread unread uses the same provider boundary", async () => {
  const providerWrites: unknown[][] = [];
  const dependencies: GmailThreadActionDependencies = {
    modifyThreadLabels: async (...input) => {
      providerWrites.push(input);
    },
    enqueueHistoryCatchup: async () => "catchup-step",
  };

  await applyGmailThreadAction(
    {
      access,
      context: { accountId, providerThreadId: "provider-thread" },
      action: "mark_unread",
      userId,
    },
    dependencies,
  );

  assert.deepEqual(providerWrites, [
    ["access-token", "provider-thread", { addLabelIds: ["UNREAD"] }],
  ]);
});

test("archiving removes the thread from the Inbox and nothing else", async () => {
  const providerWrites: unknown[][] = [];
  const dependencies: GmailThreadActionDependencies = {
    modifyThreadLabels: async (...input) => {
      providerWrites.push(input);
    },
    enqueueHistoryCatchup: async () => "catchup-step",
  };

  await applyGmailThreadAction(
    {
      access,
      context: { accountId, providerThreadId: "provider-thread" },
      action: "archive",
      userId,
    },
    dependencies,
  );

  assert.deepEqual(providerWrites, [
    ["access-token", "provider-thread", { removeLabelIds: ["INBOX"] }],
  ]);
});
