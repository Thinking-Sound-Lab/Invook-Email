import type {
  MailboxView,
  MailboxWorkspace,
  MailSearchResult,
  SessionState,
} from "@invook/contracts";
import { headers } from "next/headers";

function getApiOrigin(): string {
  return (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

async function apiRequest(path: string): Promise<Response> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");

  return fetch(`${getApiOrigin()}${path}`, {
    cache: "no-store",
    headers: cookie ? { cookie } : undefined,
  });
}

export async function getSessionState(): Promise<SessionState> {
  const response = await apiRequest("/v1/session");
  if (!response.ok) {
    throw new Error(`The session API returned ${response.status}.`);
  }
  return (await response.json()) as SessionState;
}

export async function getMailboxWorkspace(
  input: {
    cursor?: string;
    selectedThreadId?: string;
    view: MailboxView;
  },
): Promise<MailboxWorkspace | null> {
  const query = new URLSearchParams();
  query.set("view", input.view);
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.selectedThreadId) query.set("thread", input.selectedThreadId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await apiRequest(`/v1/mailbox${suffix}`);

  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`The mailbox API returned ${response.status}.`);
  }
  return (await response.json()) as MailboxWorkspace;
}

export async function searchMailbox(query: string): Promise<MailSearchResult[]> {
  const search = new URLSearchParams({ q: query });
  const response = await apiRequest(`/v1/mail/search?${search.toString()}`);
  if (response.status === 401) return [];
  if (!response.ok) {
    throw new Error(`The mail search API returned ${response.status}.`);
  }
  const body = (await response.json()) as { results: MailSearchResult[] };
  return body.results;
}
