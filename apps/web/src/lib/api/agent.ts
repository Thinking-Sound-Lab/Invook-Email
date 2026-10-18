import type {
  AgentConversationListResponse,
  AgentConversationResponse,
  AgentSocketTicketResponse,
  GmailForwardedTextResponse,
} from "@invook/contracts";
import axios from "axios";

export async function createAgentSocketTicket(): Promise<AgentSocketTicketResponse> {
  const response = await axios.post<AgentSocketTicketResponse>(
    "/v1/agent/socket-tickets",
  );
  return response.data;
}

export async function listAgentConversations(
  signal?: AbortSignal,
): Promise<AgentConversationListResponse> {
  const response = await axios.get<AgentConversationListResponse>(
    "/v1/agent/conversations",
    { signal },
  );
  return response.data;
}

export async function getAgentConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AgentConversationResponse> {
  const response = await axios.get<AgentConversationResponse>(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}`,
    { signal },
  );
  return response.data;
}

export async function deleteAgentConversation(conversationId: string): Promise<void> {
  await axios.delete(`/v1/agent/conversations/${encodeURIComponent(conversationId)}`);
}

export async function getForwardedMessageText(
  input: { accountId: string; messageId: string },
  signal?: AbortSignal,
): Promise<string> {
  const response = await axios.get<GmailForwardedTextResponse>(
    `/v1/gmail/messages/${encodeURIComponent(input.messageId)}/forwarded-text`,
    { params: { account: input.accountId }, signal },
  );
  return response.data.text;
}
