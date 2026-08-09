import type { IncomingMessage, ServerResponse } from "node:http";

import { AiConfigurationError, generateReplyDraft } from "@invook/ai";
import {
  getReplyDraftContext,
  saveDraftEdit,
  saveGeneratedDraft,
} from "@invook/database";
import { extractEmailAddress } from "@invook/gmail";

import { getCurrentSession } from "../auth/session";
import { sendJson, sendProblem } from "../http/responses";
import {
  hasAllowedMutationOrigin,
  isUuid,
  readJsonBody,
} from "../http/request";
import { serializeReplyDraft } from "../serializers";

function requireMutationAccess(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return null;
  }
  if (!hasAllowedMutationOrigin(request)) {
    sendProblem(response, requestId, 403, "Request origin is not allowed");
    return null;
  }
  return session;
}

function contactEmails(values: string[], accountEmail: string): Set<string> {
  return new Set(
    values
      .map(extractEmailAddress)
      .filter((email) => email.includes("@") && email !== accountEmail.toLowerCase()),
  );
}

export async function handleGenerateDraft(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  threadId: string,
) {
  const session = requireMutationAccess(request, response, requestId);
  if (!session) return;
  if (!isUuid(threadId)) {
    sendProblem(response, requestId, 400, "Thread ID must be valid");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    sendProblem(response, requestId, 400, "Invalid JSON request body");
    return;
  }
  const instruction =
    body && typeof body === "object" && "instruction" in body
      ? body.instruction
      : undefined;
  if (
    instruction !== undefined &&
    (typeof instruction !== "string" || instruction.trim().length > 1_000)
  ) {
    sendProblem(response, requestId, 400, "Draft instruction must be valid");
    return;
  }

  const context = await getReplyDraftContext(session.userId, threadId);
  if (!context) {
    sendProblem(response, requestId, 404, "Email thread not found");
    return;
  }

  const contacts = contactEmails(
    [
      ...context.participants,
      ...context.messages.flatMap((message) => [
        message.sender.raw,
        ...message.recipients,
      ]),
    ],
    context.accountEmail,
  );
  const applicableMemories = context.memories.filter(
    (memory) =>
      memory.type !== "contact" ||
      Boolean(memory.contactEmail && contacts.has(memory.contactEmail.toLowerCase())),
  );

  try {
    const result = await generateReplyDraft({
      subject: context.subject,
      messages: context.messages.map((message) => ({
        direction: message.direction,
        sender: message.sender.raw || message.sender.email,
        recipients: message.recipients,
        bodyText: message.bodyText,
        sentAt: message.sentAt.toISOString(),
      })),
      memories: applicableMemories,
      instruction:
        typeof instruction === "string" && instruction.trim()
          ? instruction.trim()
          : undefined,
    });
    const applicableIds = new Set(applicableMemories.map((memory) => memory.id));
    if (result.usedMemoryIds.some((id) => !applicableIds.has(id))) {
      throw new Error("The draft model cited a memory outside its supplied context.");
    }

    const draft = await saveGeneratedDraft({
      userId: session.userId,
      accountId: context.accountId,
      threadId: context.id,
      text: result.text,
      usedMemoryIds: result.usedMemoryIds,
      modelId: result.modelId,
      schedulingRelevant: result.schedulingRelevant,
    });
    if (!draft) {
      sendProblem(response, requestId, 404, "Email thread not found");
      return;
    }
    sendJson(response, requestId, 201, { draft: serializeReplyDraft(draft) });
  } catch (error) {
    if (error instanceof AiConfigurationError) {
      sendProblem(response, requestId, 503, "AI model is not configured");
      return;
    }
    throw error;
  }
}

export async function handleUpdateDraft(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  draftId: string,
) {
  const session = requireMutationAccess(request, response, requestId);
  if (!session) return;
  if (!isUuid(draftId)) {
    sendProblem(response, requestId, 400, "Draft ID must be valid");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    sendProblem(response, requestId, 400, "Invalid JSON request body");
    return;
  }
  const currentText =
    body && typeof body === "object" && "currentText" in body
      ? body.currentText
      : undefined;
  if (
    typeof currentText !== "string" ||
    currentText.trim().length === 0 ||
    currentText.length > 12_000
  ) {
    sendProblem(response, requestId, 400, "Draft text must be valid");
    return;
  }

  const draft = await saveDraftEdit({
    userId: session.userId,
    draftId,
    currentText,
  });
  if (!draft) {
    sendProblem(response, requestId, 404, "Draft not found");
    return;
  }
  sendJson(response, requestId, 200, { draft: serializeReplyDraft(draft) });
}
