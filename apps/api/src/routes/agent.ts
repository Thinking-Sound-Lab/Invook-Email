import type { IncomingMessage, ServerResponse } from "node:http";

import { createMailAgent, isAiConfigured } from "@invook/ai";
import {
  getMailboxThreadForAgent,
  listMailboxThreadAttachments,
} from "@invook/database";
import { pipeAgentUIStreamToResponse } from "ai";

import { getCurrentSession } from "../auth/session";
import { hasAllowedMutationOrigin, readJsonBody } from "../http/request";
import { sendProblem } from "../http/responses";
import { generateDraftForUser } from "../services/drafts";
import { searchMailForUser } from "../services/search";

export async function handleMailAgent(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return;
  }
  if (!hasAllowedMutationOrigin(request)) {
    sendProblem(response, requestId, 403, "Request origin is not allowed");
    return;
  }
  if (!isAiConfigured()) {
    sendProblem(response, requestId, 503, "AI model is not configured");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, 10_000_000);
  } catch {
    sendProblem(response, requestId, 400, "Invalid JSON request body");
    return;
  }
  const suppliedMessages =
    body && typeof body === "object" && "messages" in body
      ? body.messages
      : undefined;
  if (!Array.isArray(suppliedMessages)) {
    sendProblem(response, requestId, 400, "Agent messages are required");
    return;
  }
  const uiMessages = suppliedMessages.flatMap((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("id" in message) ||
      typeof message.id !== "string" ||
      !("role" in message) ||
      (message.role !== "user" && message.role !== "assistant") ||
      !("parts" in message) ||
      !Array.isArray(message.parts)
    ) {
      return [];
    }
    const parts = message.parts.flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [{ type: "text" as const, text: part.text }]
        : [],
    );
    return parts.length > 0
      ? [{ id: message.id, role: message.role, parts }]
      : [];
  });
  if (uiMessages.length === 0) {
    sendProblem(response, requestId, 400, "A text agent message is required");
    return;
  }

  const requestedThreadId =
    body &&
    typeof body === "object" &&
    "currentThreadId" in body &&
    typeof body.currentThreadId === "string"
      ? body.currentThreadId
      : null;
  const currentThread = requestedThreadId
    ? await getMailboxThreadForAgent(session.userId, requestedThreadId)
    : null;

  const agent = createMailAgent({
    searchMail: (query) =>
      searchMailForUser({
        userId: session.userId,
        query,
        onSemanticError: (error) => {
          console.error("api: agent semantic search unavailable", {
            requestId,
            name: error instanceof Error ? error.name : "UnknownError",
          });
        },
      }),
    getThread: async (threadId) => {
      const thread = await getMailboxThreadForAgent(session.userId, threadId);
      return thread
        ? {
            ...thread,
            messages: thread.messages.map((message) => ({
              ...message,
              sentAt: message.sentAt.toISOString(),
            })),
          }
        : null;
    },
    listAttachments: (threadId) =>
      listMailboxThreadAttachments(session.userId, threadId),
    draftReply: async (threadId, instruction) => {
      const draft = await generateDraftForUser({
        userId: session.userId,
        threadId,
        instruction,
      });
      if (!draft) throw new Error("The email thread was not found.");
      return {
        draftId: draft.id,
        threadId: draft.threadId,
        text: draft.currentText,
      };
    },
  }, currentThread
    ? {
        currentThreadId: currentThread.id,
      }
    : undefined);

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  await pipeAgentUIStreamToResponse({
    response,
    agent,
    uiMessages,
    abortSignal: controller.signal,
    headers: { "x-request-id": requestId },
  });
}
