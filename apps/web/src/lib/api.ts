import type {
  MailboxShell,
  MailboxSidebarCounts,
  MailboxThreadPage,
  MailboxView,
  SessionState,
} from "@invook/contracts";
import axios from "axios";
import { headers } from "next/headers";

import { getApiUrl } from "./api-url";

async function apiRequest<T>(path: string) {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const requestId = requestHeaders.get("x-request-id");

  return axios.get<T>(getApiUrl(path).toString(), {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    validateStatus: () => true,
  });
}

export async function getSessionState(): Promise<SessionState> {
  const response = await apiRequest<SessionState>("/v1/session");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The session API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxShell(): Promise<MailboxShell | null> {
  const response = await apiRequest<MailboxShell>("/v1/mailbox/shell");
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox shell API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxSidebarCounts(): Promise<MailboxSidebarCounts | null> {
  const response = await apiRequest<MailboxSidebarCounts>(
    "/v1/mailbox/sidebar-counts",
  );
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox sidebar API returned ${response.status}.`);
  }
  return response.data;
}

export async function getMailboxThreadPage(input: {
  account: string;
  view: MailboxView;
}): Promise<MailboxThreadPage | null> {
  const query = new URLSearchParams();
  query.set("account", input.account);
  query.set("view", input.view);
  const response = await apiRequest<MailboxThreadPage>(
    `/v1/mailbox/threads?${query.toString()}`,
  );

  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox thread list API returned ${response.status}.`);
  }
  return response.data;
}

/** The name an agent registered with, for the consent page; null when it gave none. */
export async function getAgentClientName(
  clientId: string,
): Promise<{ name: string | null } | null> {
  const query = new URLSearchParams({ client_id: clientId });
  const response = await apiRequest<unknown>(
    `/v1/auth/oauth2/public-client?${query.toString()}`,
  );
  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The agent client API returned ${response.status}.`);
  }
  const client: unknown = response.data;
  if (typeof client !== "object" || client === null) {
    throw new Error("The agent client API returned an invalid response.");
  }
  const name = "client_name" in client ? client.client_name : undefined;
  return { name: typeof name === "string" && name.trim() ? name.trim() : null };
}
