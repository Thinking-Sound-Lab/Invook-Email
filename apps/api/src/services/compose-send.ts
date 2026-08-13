import { createHash } from "node:crypto";

import type { GmailComposeSendResponse } from "@invook/contracts";
import {
  abandonUnpreparedGmailDraftSend,
  beginGmailDraftWrite,
  completeGmailDraftWrite,
  enqueueGmailHistoryCatchup,
  prepareGmailDraftSend,
  withGmailDraftSendLock,
  type BeginGmailDraftWriteResult,
  type GmailDraftWriteResult,
} from "@invook/database";
import {
  getGmailDraft,
  getGmailMessageState,
  GmailApiError,
  sendGmailDraft,
  type GmailDraft,
  type GmailMessageState,
} from "@invook/gmail";

import type { GmailProviderAccess } from "./gmail-provider";

export class GmailDraftSendPendingError extends Error {
  constructor() {
    super("The previous Gmail draft send is still being resolved.");
    this.name = "GmailDraftSendPendingError";
  }
}

export interface SendComposeDraftInput {
  userId: string;
  access: GmailProviderAccess;
  idempotencyKey: string;
  providerDraftId: string;
}

export interface ComposeSendDependencies {
  withSendLock: typeof withGmailDraftSendLock;
  beginWrite: typeof beginGmailDraftWrite;
  prepareSend: typeof prepareGmailDraftSend;
  completeWrite: typeof completeGmailDraftWrite;
  abandonUnpreparedSend: typeof abandonUnpreparedGmailDraftSend;
  getDraft: typeof getGmailDraft;
  getMessageState: typeof getGmailMessageState;
  sendDraft: typeof sendGmailDraft;
  enqueueCatchup: typeof enqueueGmailHistoryCatchup;
}

const defaultDependencies: ComposeSendDependencies = {
  withSendLock: withGmailDraftSendLock,
  beginWrite: beginGmailDraftWrite,
  prepareSend: prepareGmailDraftSend,
  completeWrite: completeGmailDraftWrite,
  abandonUnpreparedSend: abandonUnpreparedGmailDraftSend,
  getDraft: getGmailDraft,
  getMessageState: getGmailMessageState,
  sendDraft: sendGmailDraft,
  enqueueCatchup: enqueueGmailHistoryCatchup,
};

function requestFingerprint(providerDraftId: string): string {
  return createHash("sha256").update(providerDraftId, "utf8").digest("hex");
}

function draftTarget(draft: GmailDraft): GmailDraftWriteResult {
  return {
    providerDraftId: draft.id,
    providerMessageId: draft.message.id,
    providerThreadId: draft.message.threadId,
  };
}

function sentResult(
  providerDraftId: string,
  message: GmailMessageState,
): GmailDraftWriteResult {
  return {
    providerDraftId,
    providerMessageId: message.id,
    providerThreadId: message.threadId,
  };
}

async function completedResponse(
  input: SendComposeDraftInput,
  operationId: string,
  result: GmailDraftWriteResult,
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  const stepId = await dependencies.enqueueCatchup({
    userId: input.userId,
    accountId: input.access.accountId,
    reason: "provider_write",
    sourceId: `compose-send:${operationId}`,
  });
  return {
    message: {
      providerMessageId: result.providerMessageId,
      providerThreadId: result.providerThreadId,
    },
    stepId,
  };
}

async function completeSend(
  input: SendComposeDraftInput,
  operationId: string,
  result: GmailDraftWriteResult,
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  await dependencies.completeWrite({
    operationId,
    userId: input.userId,
    result,
  });
  return completedResponse(input, operationId, result, dependencies);
}

async function performPreparedSend(
  input: SendComposeDraftInput,
  operationId: string,
  target: GmailDraftWriteResult,
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  let message: GmailMessageState;
  try {
    message = await dependencies.sendDraft(
      input.access.accessToken,
      target.providerDraftId,
    );
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      return recoverSentMessage(input, operationId, target, dependencies);
    }
    throw error;
  }
  return completeSend(
    input,
    operationId,
    sentResult(target.providerDraftId, message),
    dependencies,
  );
}

async function recoverSentMessage(
  input: SendComposeDraftInput,
  operationId: string,
  target: GmailDraftWriteResult,
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  try {
    const message = await dependencies.getMessageState(
      input.access.accessToken,
      target.providerMessageId,
    );
    if (
      message.threadId !== target.providerThreadId ||
      !message.labelIds?.includes("SENT")
    ) {
      throw new GmailDraftSendPendingError();
    }
    return completeSend(
      input,
      operationId,
      sentResult(target.providerDraftId, message),
      dependencies,
    );
  } catch (error) {
    if (error instanceof GmailDraftSendPendingError) throw error;
    if (error instanceof GmailApiError && error.status === 404) {
      throw new GmailDraftSendPendingError();
    }
    throw error;
  }
}

async function prepareAndSend(
  input: SendComposeDraftInput,
  operationId: string,
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  let draft: GmailDraft;
  try {
    draft = await dependencies.getDraft(
      input.access.accessToken,
      input.providerDraftId,
    );
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      const wasAbandoned = await dependencies.abandonUnpreparedSend({
        operationId,
        userId: input.userId,
      });
      if (!wasAbandoned) throw new GmailDraftSendPendingError();
    }
    throw error;
  }
  const target = draftTarget(draft);
  if (target.providerDraftId !== input.providerDraftId) {
    throw new Error("Gmail returned a different draft than the requested send target.");
  }
  await dependencies.prepareSend({
    operationId,
    userId: input.userId,
    result: target,
  });
  return performPreparedSend(input, operationId, target, dependencies);
}

async function recoverPreparedSend(
  input: SendComposeDraftInput,
  pending: Extract<BeginGmailDraftWriteResult, { outcome: "pending" }> & {
    result: GmailDraftWriteResult;
  },
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  try {
    const draft = await dependencies.getDraft(
      input.access.accessToken,
      pending.result.providerDraftId,
    );
    const currentTarget = draftTarget(draft);
    if (
      currentTarget.providerMessageId !== pending.result.providerMessageId ||
      currentTarget.providerThreadId !== pending.result.providerThreadId
    ) {
      throw new GmailDraftSendPendingError();
    }
    return performPreparedSend(
      input,
      pending.operationId,
      pending.result,
      dependencies,
    );
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
  }

  return recoverSentMessage(
    input,
    pending.operationId,
    pending.result,
    dependencies,
  );
}

async function sendComposeDraftWithLock(
  input: SendComposeDraftInput,
  dependencies: ComposeSendDependencies,
): Promise<GmailComposeSendResponse> {
  const write = await dependencies.beginWrite({
    userId: input.userId,
    accountId: input.access.accountId,
    operation: "send",
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: requestFingerprint(input.providerDraftId),
  });
  if (write.outcome === "complete") {
    return completedResponse(input, write.operationId, write.result, dependencies);
  }
  if (write.outcome === "claimed") {
    return prepareAndSend(input, write.operationId, dependencies);
  }
  if (!write.result) {
    return prepareAndSend(input, write.operationId, dependencies);
  }
  return recoverPreparedSend(
    input,
    { ...write, result: write.result },
    dependencies,
  );
}

export async function sendComposeDraft(
  input: SendComposeDraftInput,
  dependencies: ComposeSendDependencies = defaultDependencies,
): Promise<GmailComposeSendResponse> {
  return dependencies.withSendLock(
    { userId: input.userId, idempotencyKey: input.idempotencyKey },
    () => sendComposeDraftWithLock(input, dependencies),
  );
}
