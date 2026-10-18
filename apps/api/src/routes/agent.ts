import type { FastifyPluginAsync } from "fastify";
import { safeValidateUIMessages } from "ai";
import { validate as validateUuid } from "uuid";
import type { RawData, WebSocket } from "ws";

import { isAiConfigured } from "@invook/ai";
import {
  AGENT_CONVERSATION_LIST_LIMIT,
  AGENT_MESSAGE_MAX_LENGTH,
  AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE,
  type AgentApprovalDecision,
  type AgentClientFrame,
  type AgentConversationListResponse,
  type AgentConversationResponse,
  type AgentFocus,
  type AgentServerFrame,
  type AgentSocketTicketResponse,
  type InvookAgentUIMessage,
} from "@invook/contracts";
import {
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
} from "@invook/database";

import { mutationAccessHooks, requireSession, requireUuidParameter } from "../access";
import { getAgentSocketUrl, getPublicAppOrigin } from "../config";
import { sendJson, sendProblem } from "../responses";
import {
  issueAgentSocketTicket,
  readAgentSocketTicket,
  redeemAgentSocketTicket,
} from "../services/agent-tickets";
import { runAgentTurn } from "../services/agent-turns";

const APPROVAL_DECISION_LIMIT = 20;
const APPROVAL_ID_LIMIT = 256;

type ConversationParams = { conversationId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowedKeys = new Set(keys);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function parseFocus(value: unknown): AgentFocus | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["accountSelection", "threadId"])) {
    return null;
  }
  const { accountSelection, threadId } = value;
  if (
    typeof accountSelection !== "string" ||
    (accountSelection !== "all" && !validateUuid(accountSelection))
  ) {
    return null;
  }
  if (threadId !== null && (typeof threadId !== "string" || !validateUuid(threadId))) {
    return null;
  }
  return { accountSelection, threadId };
}

function parseDecisions(value: unknown): AgentApprovalDecision[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > APPROVAL_DECISION_LIMIT
  ) {
    return null;
  }
  const decisions: AgentApprovalDecision[] = [];
  for (const decision of value) {
    if (
      !isRecord(decision) ||
      !hasOnlyKeys(decision, ["approvalId", "approved"]) ||
      typeof decision.approvalId !== "string" ||
      decision.approvalId.length === 0 ||
      decision.approvalId.length > APPROVAL_ID_LIMIT ||
      typeof decision.approved !== "boolean"
    ) {
      return null;
    }
    decisions.push({
      approvalId: decision.approvalId,
      approved: decision.approved,
    });
  }
  return decisions;
}

export function parseAgentClientFrame(value: unknown): AgentClientFrame | null {
  if (
    !isRecord(value) ||
    typeof value.conversationId !== "string" ||
    !validateUuid(value.conversationId)
  ) {
    return null;
  }
  const { conversationId } = value;
  if (value.type === "stop") {
    return hasOnlyKeys(value, ["type", "conversationId"])
      ? { type: "stop", conversationId }
      : null;
  }
  if (value.type === "message") {
    if (
      !hasOnlyKeys(value, ["type", "conversationId", "messageId", "text", "focus"]) ||
      typeof value.messageId !== "string" ||
      !validateUuid(value.messageId) ||
      typeof value.text !== "string"
    ) {
      return null;
    }
    const text = value.text.trim();
    const focus = parseFocus(value.focus);
    if (!text || text.length > AGENT_MESSAGE_MAX_LENGTH || !focus) return null;
    return { type: "message", conversationId, messageId: value.messageId, text, focus };
  }
  if (value.type === "approval") {
    if (!hasOnlyKeys(value, ["type", "conversationId", "decisions", "focus"])) {
      return null;
    }
    const decisions = parseDecisions(value.decisions);
    const focus = parseFocus(value.focus);
    if (!decisions || !focus) return null;
    return { type: "approval", conversationId, decisions, focus };
  }
  return null;
}

function readFrameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function parseFrameJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export interface AgentSocketDependencies {
  runTurn: typeof runAgentTurn;
}

export interface AgentRouteDependencies extends AgentSocketDependencies {
  redeemTicket: typeof redeemAgentSocketTicket;
}

const defaultRouteDependencies: AgentRouteDependencies = {
  runTurn: runAgentTurn,
  redeemTicket: redeemAgentSocketTicket,
};

/**
 * Serves one browser's agent socket. A socket runs one turn at a time, and
 * closing it aborts that turn; what the turn already did is stored by the turn.
 */
function serveAgentSocket(
  socket: WebSocket,
  identity: { userId: string; sessionId: string },
  dependencies: AgentSocketDependencies = { runTurn: runAgentTurn },
): void {
  let activeTurn: { conversationId: string; controller: AbortController } | null =
    null;
  const send = (frame: AgentServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, "Text frames only");
      return;
    }
    const frame = parseAgentClientFrame(parseFrameJson(readFrameText(data)));
    if (!frame) {
      socket.close(1008, "Invalid frame");
      return;
    }
    if (frame.type === "stop") {
      if (activeTurn?.conversationId === frame.conversationId) {
        activeTurn.controller.abort();
      }
      return;
    }
    if (activeTurn) {
      send({ type: "rejected", conversationId: frame.conversationId, reason: "busy" });
      return;
    }
    const turn = {
      conversationId: frame.conversationId,
      controller: new AbortController(),
    };
    activeTurn = turn;
    void dependencies
      .runTurn({
        ...identity,
        frame,
        abortSignal: turn.controller.signal,
        send,
      })
      .then(({ isSessionEnded }) => {
        if (isSessionEnded) {
          socket.close(AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE, "Session ended");
        }
      })
      .catch((error: unknown) => {
        console.error("api: agent socket turn failed", {
          conversationId: frame.conversationId,
          name: error instanceof Error ? error.name : "UnknownError",
        });
        send({
          type: "rejected",
          conversationId: frame.conversationId,
          reason: "unavailable",
        });
      })
      .finally(() => {
        if (activeTurn === turn) activeTurn = null;
      });
  });
  socket.on("close", () => {
    activeTurn?.controller.abort();
  });
}

function isAgentConfigured(): boolean {
  return isAiConfigured() && getAgentSocketUrl() !== null;
}

export function registerAgentRoutes(
  overrides: Partial<AgentRouteDependencies> = {},
): FastifyPluginAsync {
  const dependencies = { ...defaultRouteDependencies, ...overrides };
  return async (api) => {
    api.post(
      "/v1/agent/socket-tickets",
      { onRequest: mutationAccessHooks },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const socketUrl = getAgentSocketUrl();
        if (!socketUrl || !isAiConfigured()) {
          await sendProblem(request, reply, 503, "The agent is not configured on this server");
          return;
        }
        const { ticket, expiresAt } = await issueAgentSocketTicket({
          userId: session.userId,
          sessionId: session.sessionId,
        });
        const response: AgentSocketTicketResponse = {
          ticket,
          socketUrl,
          expiresAt: expiresAt.toISOString(),
        };
        await sendJson(reply, 201, response);
      },
    );

    api.get(
      "/v1/agent/socket",
      {
        websocket: true,
        // Authentication runs before the upgrade, so a socket only ever opens
        // for a redeemed ticket from the application's own origin.
        onRequest: async (request, reply) => {
          if (!request.ws) {
            await sendProblem(request, reply, 426, "WebSocket upgrade required");
            return;
          }
          if (request.headers.origin !== getPublicAppOrigin()) {
            await sendProblem(request, reply, 403, "Request origin is not allowed");
            return;
          }
          if (!isAgentConfigured()) {
            await sendProblem(request, reply, 503, "The agent is not configured on this server");
            return;
          }
          const ticket = readAgentSocketTicket(request.headers["sec-websocket-protocol"]);
          const identity = ticket ? await dependencies.redeemTicket(ticket) : null;
          if (!identity) {
            await sendProblem(request, reply, 401, "Authentication required");
            return;
          }
          request.invookAgentSocket = identity;
        },
      },
      (socket, request) => {
        const identity = request.invookAgentSocket;
        if (!identity) {
          socket.close(1008, "Authentication required");
          return;
        }
        serveAgentSocket(socket, identity, dependencies);
      },
    );

    api.get(
      "/v1/agent/conversations",
      { onRequest: requireSession },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const conversations = await listAgentConversations({
          userId: session.userId,
          limit: AGENT_CONVERSATION_LIST_LIMIT,
        });
        const response: AgentConversationListResponse = {
          conversations: conversations.map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            updatedAt: conversation.updatedAt.toISOString(),
          })),
        };
        await sendJson(reply, 200, response);
      },
    );

    api.delete<{ Params: ConversationParams }>(
      "/v1/agent/conversations/:conversationId",
      {
        onRequest: [
          ...mutationAccessHooks,
          requireUuidParameter("conversationId", "Agent conversation ID must be valid"),
        ],
      },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const isDeleted = await deleteAgentConversation({
          userId: session.userId,
          conversationId: request.params.conversationId,
        });
        if (!isDeleted) {
          await sendProblem(request, reply, 404, "Agent conversation not found");
          return;
        }
        await reply.code(204).send();
      },
    );

    api.get<{ Params: ConversationParams }>(
      "/v1/agent/conversations/:conversationId",
      {
        onRequest: [
          requireSession,
          requireUuidParameter("conversationId", "Agent conversation ID must be valid"),
        ],
      },
      async (request, reply) => {
        const session = request.invookSession;
        if (!session) return;
        const stored = await getAgentConversation({
          userId: session.userId,
          conversationId: request.params.conversationId,
        });
        if (!stored) {
          await sendProblem(request, reply, 404, "Agent conversation not found");
          return;
        }
        const validation = await safeValidateUIMessages<InvookAgentUIMessage>({
          messages: stored.messages,
        });
        if (!validation.success) {
          console.error("api: stored agent conversation is invalid", {
            conversationId: stored.conversation.id,
          });
          await sendProblem(request, reply, 500, "Agent conversation is unavailable");
          return;
        }
        const response: AgentConversationResponse = {
          conversation: {
            id: stored.conversation.id,
            title: stored.conversation.title,
            updatedAt: stored.conversation.updatedAt.toISOString(),
          },
          messages: validation.data,
        };
        await sendJson(reply, 200, response);
      },
    );
  };
}
