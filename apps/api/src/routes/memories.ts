import type { IncomingMessage, ServerResponse } from "node:http";

import { isAiConfigured } from "@invook/ai";
import { memoryTypes, type MemoryType } from "@invook/contracts";
import {
  createUserMemory,
  deleteUserMemory,
  getMemoriesForUser,
  MemoryConflictError,
  updateUserMemory,
} from "@invook/database";

import { getCurrentSession } from "../auth/session";
import { sendJson, sendProblem } from "../http/responses";
import {
  hasAllowedMutationOrigin,
  isUuid,
  readJsonBody,
} from "../http/request";
import { serializeMemoryEntry } from "../serializers";

type MemoryPayload = {
  type: MemoryType;
  contactEmail: string | null;
  statement: string;
};

function parseMemoryPayload(body: unknown): MemoryPayload | null {
  if (!body || typeof body !== "object") return null;
  const type = "type" in body ? body.type : undefined;
  const statement = "statement" in body ? body.statement : undefined;
  const contactEmail = "contactEmail" in body ? body.contactEmail : null;
  if (
    typeof type !== "string" ||
    !memoryTypes.includes(type as MemoryType) ||
    typeof statement !== "string"
  ) {
    return null;
  }

  const normalizedStatement = statement.trim().replace(/\s+/g, " ");
  if (normalizedStatement.length < 3 || normalizedStatement.length > 500) return null;
  if (type === "contact") {
    if (typeof contactEmail !== "string") return null;
    const normalizedEmail = contactEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return null;
    return {
      type: type as MemoryType,
      contactEmail: normalizedEmail,
      statement: normalizedStatement,
    };
  }

  return {
    type: type as MemoryType,
    contactEmail: null,
    statement: normalizedStatement,
  };
}

async function requirePayload(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    sendProblem(response, requestId, 400, "Invalid JSON request body");
    return null;
  }
  const payload = parseMemoryPayload(body);
  if (!payload) {
    sendProblem(response, requestId, 400, "Memory type and statement must be valid");
    return null;
  }
  return payload;
}

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

export async function handleGetMemories(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const session = getCurrentSession(request);
  if (!session) {
    sendProblem(response, requestId, 401, "Authentication required");
    return;
  }
  const result = await getMemoriesForUser(session.userId);
  if (!result) {
    sendProblem(response, requestId, 404, "Connected Gmail account not found");
    return;
  }
  sendJson(response, requestId, 200, {
    aiConfigured: isAiConfigured(),
    syncState: result.account.syncState.memory,
    memories: result.entries.map((entry) =>
      serializeMemoryEntry({ ...entry, memoryType: entry.type }),
    ),
  });
}

export async function handleCreateMemory(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) {
  const session = requireMutationAccess(request, response, requestId);
  if (!session) return;
  const payload = await requirePayload(request, response, requestId);
  if (!payload) return;

  const memory = await createUserMemory({ userId: session.userId, ...payload });
  if (!memory) {
    sendProblem(response, requestId, 404, "Connected Gmail account not found");
    return;
  }
  sendJson(response, requestId, 201, { memory: serializeMemoryEntry(memory) });
}

export async function handleUpdateMemory(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  memoryId: string,
) {
  const session = requireMutationAccess(request, response, requestId);
  if (!session) return;
  if (!isUuid(memoryId)) {
    sendProblem(response, requestId, 400, "Memory ID must be valid");
    return;
  }
  const payload = await requirePayload(request, response, requestId);
  if (!payload) return;

  try {
    const memory = await updateUserMemory({
      userId: session.userId,
      memoryId,
      ...payload,
    });
    if (!memory) {
      sendProblem(response, requestId, 404, "Memory not found");
      return;
    }
    sendJson(response, requestId, 200, { memory: serializeMemoryEntry(memory) });
  } catch (error) {
    if (error instanceof MemoryConflictError) {
      sendProblem(response, requestId, 409, error.message);
      return;
    }
    throw error;
  }
}

export async function handleDeleteMemory(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  memoryId: string,
) {
  const session = requireMutationAccess(request, response, requestId);
  if (!session) return;
  if (!isUuid(memoryId)) {
    sendProblem(response, requestId, 400, "Memory ID must be valid");
    return;
  }
  const deleted = await deleteUserMemory({ userId: session.userId, memoryId });
  if (!deleted) {
    sendProblem(response, requestId, 404, "Memory not found");
    return;
  }
  sendJson(response, requestId, 200, { deleted: true });
}
