import { createHash } from "node:crypto";

import { v5 as uuidv5 } from "uuid";

import {
  abandonPendingGmailDraftWrite,
  beginGmailDraftWrite,
  completeGmailDraftWrite,
  enqueueGmailHistoryCatchup,
  type BeginGmailDraftWriteResult,
  type GmailDraftWriteResult,
} from "@invook/database";
import {
  composePlainTextGmailReply,
  createGmailDraft,
  GmailApiError,
  listGmailDrafts,
  type GmailDraftPage,
} from "@invook/gmail";

import type { GmailProviderAccess } from "./gmail-provider";
import { GmailDraftWritePendingError } from "./compose-drafts";

export class GmailReplyComposeError extends Error {
  constructor() {
    super("The Gmail reply has no valid recipient.");
    this.name = "GmailReplyComposeError";
  }
}

type ReplyTarget = {
  sender: { raw: string; email: string };
  headerLines: { key: string; line: string }[];
};

export interface PromoteReplyDraftInput {
  userId: string;
  access: GmailProviderAccess;
  draftId: string;
  updatedAt: Date;
  accountEmail: string;
  providerThreadId: string;
  subject: string;
  currentText: string;
  replyTarget: ReplyTarget;
}

export interface PromoteReplyDraftDependencies {
  beginWrite: typeof beginGmailDraftWrite;
  completeWrite: typeof completeGmailDraftWrite;
  abandonWrite: typeof abandonPendingGmailDraftWrite;
  createDraft: typeof createGmailDraft;
  listDrafts: typeof listGmailDrafts;
  enqueueCatchup: typeof enqueueGmailHistoryCatchup;
}

const defaultDependencies: PromoteReplyDraftDependencies = {
  beginWrite: beginGmailDraftWrite,
  completeWrite: completeGmailDraftWrite,
  abandonWrite: abandonPendingGmailDraftWrite,
  createDraft: createGmailDraft,
  listDrafts: listGmailDrafts,
  enqueueCatchup: enqueueGmailHistoryCatchup,
};

function idempotencyKey(input: PromoteReplyDraftInput): string {
  return uuidv5(
    `https://invook.dev/reply-drafts/${input.draftId}/versions/${input.updatedAt.toISOString()}`,
    uuidv5.URL,
  );
}

function requestFingerprint(input: PromoteReplyDraftInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        draftId: input.draftId,
        updatedAt: input.updatedAt.toISOString(),
        providerThreadId: input.providerThreadId,
        subject: input.subject,
        currentText: input.currentText,
        replyTarget: input.replyTarget,
      }),
      "utf8",
    )
    .digest("hex");
}

function operationMessageId(operationId: string): string {
  return `invook-reply-${operationId}@invook.invalid`;
}

function providerResult(draft: {
  id: string;
  message: { id: string; threadId: string };
}): GmailDraftWriteResult {
  return {
    providerDraftId: draft.id,
    providerMessageId: draft.message.id,
    providerThreadId: draft.message.threadId,
  };
}

function draftPageResult(page: GmailDraftPage): GmailDraftWriteResult | null {
  const drafts = page.drafts ?? [];
  if (drafts.length !== 1) return null;
  const draft = drafts[0];
  return draft ? providerResult(draft) : null;
}

async function completedResponse(
  input: PromoteReplyDraftInput,
  operationId: string,
  result: GmailDraftWriteResult,
  dependencies: PromoteReplyDraftDependencies,
): Promise<{ draft: GmailDraftWriteResult; stepId: string }> {
  const stepId = await dependencies.enqueueCatchup({
    userId: input.userId,
    accountId: input.access.accountId,
    reason: "provider_write",
    sourceId: `promote-reply-draft:${operationId}`,
  });
  return { draft: result, stepId };
}

async function recoverPendingWrite(
  input: PromoteReplyDraftInput,
  pending: Extract<BeginGmailDraftWriteResult, { outcome: "pending" }>,
  dependencies: PromoteReplyDraftDependencies,
): Promise<{ draft: GmailDraftWriteResult; stepId: string }> {
  const page = await dependencies.listDrafts(input.access.accessToken, {
    maxResults: 2,
    query: `rfc822msgid:${operationMessageId(pending.operationId)}`,
  });
  const result = draftPageResult(page);
  if (!result) throw new GmailDraftWritePendingError();
  await dependencies.completeWrite({
    operationId: pending.operationId,
    userId: input.userId,
    result,
  });
  return completedResponse(input, pending.operationId, result, dependencies);
}

export async function promoteReplyDraftToGmail(
  input: PromoteReplyDraftInput,
  dependencies: PromoteReplyDraftDependencies = defaultDependencies,
): Promise<{ draft: GmailDraftWriteResult; stepId: string }> {
  const write = await dependencies.beginWrite({
    userId: input.userId,
    accountId: input.access.accountId,
    operation: "create",
    idempotencyKey: idempotencyKey(input),
    requestFingerprint: requestFingerprint(input),
  });
  if (write.outcome === "complete") {
    return completedResponse(input, write.operationId, write.result, dependencies);
  }
  if (write.outcome === "pending") {
    return recoverPendingWrite(input, write, dependencies);
  }

  const raw = composePlainTextGmailReply({
    accountEmail: input.accountEmail,
    subject: input.subject,
    currentText: input.currentText,
    messageId: operationMessageId(write.operationId),
    replyTarget: input.replyTarget,
  });
  if (!raw) {
    await dependencies.abandonWrite({
      operationId: write.operationId,
      userId: input.userId,
    });
    throw new GmailReplyComposeError();
  }

  let hasStartedProviderWrite = false;
  try {
    hasStartedProviderWrite = true;
    const created = await dependencies.createDraft(input.access.accessToken, {
      raw,
      threadId: input.providerThreadId,
    });
    const result = providerResult(created);
    await dependencies.completeWrite({
      operationId: write.operationId,
      userId: input.userId,
      result,
    });
    return completedResponse(input, write.operationId, result, dependencies);
  } catch (error) {
    const isKnownProviderRejection = error instanceof GmailApiError && error.status > 0;
    if (!hasStartedProviderWrite || isKnownProviderRejection) {
      await dependencies.abandonWrite({
        operationId: write.operationId,
        userId: input.userId,
      });
    }
    throw error;
  }
}
