import type { MailboxWorkspace, SessionState } from "@invook/contracts";
import axios from "axios";
import { headers } from "next/headers";

function getApiOrigin(): string {
  return (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

async function apiRequest<T>(path: string) {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  return axios.get<T>(`${getApiOrigin()}${path}`, {
    headers: cookie ? { cookie } : undefined,
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

export async function getMailboxWorkspace(
  selectedThreadId?: string,
): Promise<MailboxWorkspace | null> {
  const query = new URLSearchParams();
  if (selectedThreadId) query.set("thread", selectedThreadId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await apiRequest<MailboxWorkspace>(`/v1/mailbox${suffix}`);

  if (response.status === 401 || response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The mailbox API returned ${response.status}.`);
  }
  return response.data;
}
