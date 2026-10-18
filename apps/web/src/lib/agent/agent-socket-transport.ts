import { safeValidateTypes } from "@ai-sdk/provider-utils";
import { isToolUIPart, uiMessageChunkSchema, type ChatTransport } from "ai";
import {
  AGENT_SOCKET_PROTOCOL,
  AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE,
  AGENT_SOCKET_TICKET_PROTOCOL_PREFIX,
  type AgentClientFrame,
  type AgentFocus,
  type AgentServerFrame,
  type AgentSocketTicketResponse,
  type AgentTurnRejection,
  type InvookAgentUIMessage,
  type InvookAgentUIMessageChunk,
} from "@invook/contracts";

import { apiErrorMessage } from "@/lib/http-error";

export type AgentTurnFrame = Extract<
  AgentClientFrame,
  { type: "message" | "approval" }
>;

const rejectionMessages: Record<AgentTurnRejection, string> = {
  busy: "The agent is still working on this conversation. Try again when it finishes.",
  invalid: "The agent could not accept that request.",
  not_found: "This conversation is no longer available.",
  session_ended: "Your session ended. Sign in again to use the agent.",
  unavailable: "The agent is unavailable right now. Try again.",
};

const turnRejections = new Set<string>(Object.keys(rejectionMessages));

class AgentTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTurnError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTurnRejection(value: unknown): value is AgentTurnRejection {
  return typeof value === "string" && turnRejections.has(value);
}

/**
 * Reads one server frame. Chunks are validated against the SDK's own chunk
 * schema, the same check its HTTP transport applies to a response stream.
 */
export async function readAgentServerFrame(
  serializedFrame: string,
): Promise<AgentServerFrame | null> {
  let value: unknown;
  try {
    value = JSON.parse(serializedFrame);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.conversationId !== "string") return null;
  const { conversationId } = value;
  if (value.type === "end") return { type: "end", conversationId };
  if (value.type === "rejected") {
    return isTurnRejection(value.reason)
      ? { type: "rejected", conversationId, reason: value.reason }
      : null;
  }
  if (value.type !== "chunk") return null;
  const chunk = await safeValidateTypes({
    value: value.chunk,
    schema: uiMessageChunkSchema,
  });
  return chunk.success
    ? { type: "chunk", conversationId, chunk: chunk.value }
    : null;
}

/**
 * Turns the chat's next request into a frame. Only the newest user text or
 * the user's approval decisions are sent; the server holds the history.
 */
export function createAgentTurnFrame(input: {
  conversationId: string;
  messages: InvookAgentUIMessage[];
  focus: AgentFocus;
}): AgentTurnFrame | null {
  const lastMessage = input.messages.at(-1);
  if (lastMessage?.role === "user") {
    const text = lastMessage.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    return text
      ? {
          type: "message",
          conversationId: input.conversationId,
          messageId: lastMessage.id,
          text,
          focus: input.focus,
        }
      : null;
  }
  if (lastMessage?.role === "assistant") {
    const decisions = lastMessage.parts.flatMap((part) =>
      isToolUIPart(part) && part.state === "approval-responded"
        ? [{ approvalId: part.approval.id, approved: part.approval.approved }]
        : [],
    );
    return decisions.length > 0
      ? {
          type: "approval",
          conversationId: input.conversationId,
          decisions,
          focus: input.focus,
        }
      : null;
  }
  return null;
}

/** The parts of the browser WebSocket the connection uses, so tests can supply one. */
export interface AgentSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  removeEventListener(type: "open" | "close", listener: () => void): void;
}

export interface AgentSocketConnectionDependencies {
  createTicket: () => Promise<AgentSocketTicketResponse>;
  createSocket: (url: string, protocols: string[]) => AgentSocketLike;
}

const SOCKET_OPEN = 1;

/**
 * One browser connection to the agent socket, opened on demand with a fresh
 * one-time ticket. Connections close when idle or when the server restarts, so
 * the next request simply opens a new one.
 */
export class AgentSocketConnection {
  private socket: AgentSocketLike | null = null;
  private opening: Promise<AgentSocketLike> | null = null;
  private readonly turns = new Map<
    string,
    ReadableStreamDefaultController<InvookAgentUIMessageChunk>
  >();
  // Frame validation is asynchronous; one queue keeps chunks in socket order.
  private frameQueue: Promise<void> = Promise.resolve();
  private isActive = true;

  constructor(private readonly dependencies: AgentSocketConnectionDependencies) {}

  async startTurn(
    frame: AgentTurnFrame,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<InvookAgentUIMessageChunk>> {
    const { conversationId } = frame;
    if (this.turns.has(conversationId)) {
      throw new AgentTurnError(rejectionMessages.busy);
    }
    const socket = await this.open();
    const stream = new ReadableStream<InvookAgentUIMessageChunk>({
      start: (controller) => {
        this.turns.set(conversationId, controller);
      },
      cancel: () => {
        this.turns.delete(conversationId);
      },
    });
    abortSignal?.addEventListener(
      "abort",
      () => {
        this.turns.delete(conversationId);
        this.sendFrame({ type: "stop", conversationId });
      },
      { once: true },
    );
    socket.send(JSON.stringify(frame));
    return stream;
  }

  /** Allows sockets to open while the pane is mounted. */
  activate(): void {
    this.isActive = true;
  }

  /** Closes the socket when the pane unmounts; the server aborts any running turn. */
  deactivate(): void {
    this.isActive = false;
    this.socket?.close(1000, "Agent pane closed");
    this.socket = null;
  }

  private sendFrame(frame: AgentClientFrame): void {
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private open(): Promise<AgentSocketLike> {
    if (this.socket?.readyState === SOCKET_OPEN) return Promise.resolve(this.socket);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<AgentSocketLike> {
    if (!this.isActive) throw new AgentTurnError(rejectionMessages.unavailable);
    let ticket: AgentSocketTicketResponse;
    try {
      ticket = await this.dependencies.createTicket();
    } catch (error) {
      throw new AgentTurnError(apiErrorMessage(error, rejectionMessages.unavailable));
    }
    const socket = this.dependencies.createSocket(ticket.socketUrl, [
      AGENT_SOCKET_PROTOCOL,
      `${AGENT_SOCKET_TICKET_PROTOCOL_PREFIX}${ticket.ticket}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        socket.removeEventListener("close", handleClose);
        resolve();
      };
      const handleClose = () => {
        socket.removeEventListener("open", handleOpen);
        reject(new AgentTurnError("The agent connection could not be opened."));
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("close", handleClose);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const serializedFrame = event.data;
      this.frameQueue = this.frameQueue.then(() => this.routeFrame(serializedFrame));
    });
    socket.addEventListener("close", (event) => {
      this.frameQueue = this.frameQueue.then(() => this.handleClose(socket, event.code));
    });
    if (!this.isActive) {
      socket.close(1000, "Agent pane closed");
      throw new AgentTurnError(rejectionMessages.unavailable);
    }
    this.socket = socket;
    return socket;
  }

  private async routeFrame(serializedFrame: string): Promise<void> {
    const frame = await readAgentServerFrame(serializedFrame);
    if (!frame) {
      this.failTurns(new AgentTurnError("The agent sent a response Invook could not read."));
      this.socket?.close(1002, "Invalid frame");
      return;
    }
    const controller = this.turns.get(frame.conversationId);
    if (!controller) return;
    if (frame.type === "chunk") {
      controller.enqueue(frame.chunk);
      return;
    }
    this.turns.delete(frame.conversationId);
    if (frame.type === "end") controller.close();
    else controller.error(new AgentTurnError(rejectionMessages[frame.reason]));
  }

  private handleClose(socket: AgentSocketLike, code: number): void {
    if (this.socket === socket) this.socket = null;
    this.failTurns(
      new AgentTurnError(
        code === AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE
          ? rejectionMessages.session_ended
          : "The agent connection closed before the response finished.",
      ),
    );
  }

  private failTurns(error: AgentTurnError): void {
    for (const controller of this.turns.values()) controller.error(error);
    this.turns.clear();
  }
}

export class AgentSocketTransport implements ChatTransport<InvookAgentUIMessage> {
  constructor(
    private readonly connection: AgentSocketConnection,
    private focus: AgentFocus,
  ) {}

  /** Records what the user is looking at, which the next request carries. */
  setFocus(focus: AgentFocus): void {
    this.focus = focus;
  }

  async sendMessages({
    chatId,
    messages,
    abortSignal,
    trigger,
  }: Parameters<ChatTransport<InvookAgentUIMessage>["sendMessages"]>[0]) {
    if (trigger === "regenerate-message") {
      throw new AgentTurnError("Regenerating a response is not supported.");
    }
    const frame = createAgentTurnFrame({
      conversationId: chatId,
      messages,
      focus: this.focus,
    });
    if (!frame) throw new AgentTurnError("There is nothing to send.");
    return this.connection.startTurn(frame, abortSignal);
  }

  // A turn belongs to the socket that started it; a reload reads stored history.
  async reconnectToStream() {
    return null;
  }
}
