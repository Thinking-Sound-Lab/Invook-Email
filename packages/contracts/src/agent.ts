import type { InferUIMessageChunk, UIDataTypes, UIMessage } from "ai";

/** Subprotocol the agent socket speaks; the server selects it on upgrade. */
export const AGENT_SOCKET_PROTOCOL = "invook.agent.v1";

/**
 * Browsers cannot set headers on a WebSocket handshake, so the one-time ticket
 * travels as a second offered subprotocol. Unlike a query parameter, it stays
 * out of the request line that proxies and load balancers log.
 */
export const AGENT_SOCKET_TICKET_PROTOCOL_PREFIX = "invook.ticket.";

export const AGENT_MESSAGE_MAX_LENGTH = 4_000;
export const AGENT_CONVERSATION_LIST_LIMIT = 30;

/** Application close code sent when the socket's sign-in session has ended. */
export const AGENT_SOCKET_SESSION_ENDED_CLOSE_CODE = 4401;

/**
 * What the user is looking at when they send a message. The server re-reads
 * the open thread under the user's own scope, so this is an address, never
 * mailbox content.
 */
export type AgentFocus = {
  /** `all` or the connected account ID in the mailbox address. */
  accountSelection: string;
  threadId: string | null;
};

export type AgentMailSearchInput = {
  query: string;
  accountId: string | null;
};

export type AgentMailSearchHit = {
  accountId: string;
  threadId: string;
  messageId: string;
  subject: string;
  sender: string;
  sentAt: string;
  preview: string;
  attachmentFilenames: string[];
};

export type AgentToolFailure = {
  status: "failed";
  reason: string;
};

export type AgentMailSearchOutput =
  | { status: "available"; results: AgentMailSearchHit[] }
  | AgentToolFailure;

export type AgentThreadReadInput = {
  threadId: string;
};

export type AgentThreadMessage = {
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  sentAt: string;
  isDraft: boolean;
  body: string;
  attachmentFilenames: string[];
};

export type AgentThreadContent = {
  threadId: string;
  accountId: string;
  accountEmail: string;
  subject: string;
  /** Messages omitted from the start of a long thread. */
  earlierMessageCount: number;
  messages: AgentThreadMessage[];
};

export type AgentThreadReadOutput =
  | { status: "available"; thread: AgentThreadContent }
  | { status: "unavailable" };

/**
 * One Gmail message the agent proposes. Every field is required so the model
 * states an explicit null instead of omitting a value.
 */
export type AgentEmailInput = {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  replyToMessageId: string | null;
  forwardOfMessageId: string | null;
  /** A Gmail draft this conversation saved earlier, to revise instead of duplicate. */
  draftId: string | null;
};

export type AgentDraftOutput =
  | {
      status: "saved";
      accountId: string;
      providerDraftId: string;
      providerThreadId: string;
    }
  | AgentToolFailure;

export type AgentSendOutput =
  | {
      status: "sent";
      accountId: string;
      providerMessageId: string;
      providerThreadId: string;
    }
  | AgentToolFailure;

export type InvookAgentUITools = {
  searchMail: { input: AgentMailSearchInput; output: AgentMailSearchOutput };
  readThread: { input: AgentThreadReadInput; output: AgentThreadReadOutput };
  saveDraft: { input: AgentEmailInput; output: AgentDraftOutput };
  sendEmail: { input: AgentEmailInput; output: AgentSendOutput };
};

/**
 * Data parts keep the SDK's open default so a streamed chunk validated against
 * the SDK's own chunk schema is this type without a cast. The agent sends none.
 */
export type InvookAgentUIMessage = UIMessage<unknown, UIDataTypes, InvookAgentUITools>;
export type InvookAgentUIMessageChunk = InferUIMessageChunk<InvookAgentUIMessage>;

export type AgentApprovalDecision = {
  approvalId: string;
  approved: boolean;
};

export type AgentClientFrame =
  | {
      type: "message";
      conversationId: string;
      messageId: string;
      text: string;
      focus: AgentFocus;
    }
  | {
      type: "approval";
      conversationId: string;
      decisions: AgentApprovalDecision[];
      focus: AgentFocus;
    }
  | { type: "stop"; conversationId: string };

export type AgentTurnRejection =
  | "busy"
  | "invalid"
  | "not_found"
  | "session_ended"
  | "unavailable";

export type AgentServerFrame =
  | {
      type: "chunk";
      conversationId: string;
      chunk: InvookAgentUIMessageChunk;
    }
  | { type: "end"; conversationId: string }
  | {
      type: "rejected";
      conversationId: string;
      reason: AgentTurnRejection;
    };

export type AgentSocketTicketResponse = {
  ticket: string;
  socketUrl: string;
  expiresAt: string;
};

export type AgentConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type AgentConversationListResponse = {
  conversations: AgentConversationSummary[];
};

export type AgentConversationResponse = {
  conversation: AgentConversationSummary;
  messages: InvookAgentUIMessage[];
};
