import type { McpConnectionsResponse } from "@invook/contracts";
import axios from "axios";

export async function getMcpConnections(): Promise<McpConnectionsResponse> {
  const response = await axios.get<McpConnectionsResponse>("/v1/mcp/connections");
  return response.data;
}

export async function disconnectMcpConnection(clientId: string): Promise<void> {
  await axios.delete(`/v1/mcp/connections/${encodeURIComponent(clientId)}`);
}

type AgentConsentResponse = {
  redirect: boolean;
  url?: string;
};

export interface SubmitAgentConsentInput {
  isApproved: boolean;
  /** The signed authorization request from the consent page's query string. */
  oauthQuery: string;
}

/**
 * Records the person's decision and returns where the browser goes next: the
 * agent's callback with a code, or with an access_denied error.
 */
export async function submitAgentConsent({
  isApproved,
  oauthQuery,
}: SubmitAgentConsentInput): Promise<string> {
  const response = await axios.post<AgentConsentResponse>(
    "/v1/auth/oauth2/consent",
    { accept: isApproved, oauth_query: oauthQuery },
  );
  if (!response.data.redirect || !response.data.url) {
    throw new Error("The consent response did not include a redirect.");
  }
  return response.data.url;
}
