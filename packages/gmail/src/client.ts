import axios from "axios";

export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

export type GmailMessageReference = {
  id: string;
  threadId: string;
};

export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: {
    attachmentId?: string;
    data?: string;
    size?: number;
  };
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
};

export type GmailMessagePage = {
  messages?: GmailMessageReference[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailHistoryPage = {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: GmailMessageReference }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
};

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

async function gmailRequest<T>(
  accessToken: string,
  path: string,
): Promise<T> {
  try {
    const response = await axios.get<T>(
      `https://gmail.googleapis.com/gmail/v1${path}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    return response.data;
  } catch (error) {
    if (!axios.isAxiosError(error) || !error.response) throw error;
    throw new GmailApiError(
      `Gmail API request failed with status ${error.response.status}.`,
      error.response.status,
      responseText(error.response.data),
    );
  }
}

function responseText(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

export function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  return gmailRequest<GmailProfile>(accessToken, "/users/me/profile");
}

export function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage> {
  return gmailRequest<GmailMessage>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  );
}

export function listGmailMessages(
  accessToken: string,
  options: {
    labelId?: "INBOX" | "SENT";
    maxResults: number;
    pageToken?: string;
  },
): Promise<GmailMessagePage> {
  const search = new URLSearchParams({
    maxResults: String(options.maxResults),
  });
  if (options.labelId) search.set("labelIds", options.labelId);
  if (options.pageToken) search.set("pageToken", options.pageToken);

  return gmailRequest<GmailMessagePage>(
    accessToken,
    `/users/me/messages?${search.toString()}`,
  );
}

export function listGmailHistory(
  accessToken: string,
  options: {
    startHistoryId: string;
    maxResults: number;
    pageToken?: string;
  },
): Promise<GmailHistoryPage> {
  const search = new URLSearchParams({
    startHistoryId: options.startHistoryId,
    historyTypes: "messageAdded",
    maxResults: String(options.maxResults),
  });
  if (options.pageToken) search.set("pageToken", options.pageToken);

  return gmailRequest<GmailHistoryPage>(
    accessToken,
    `/users/me/history?${search.toString()}`,
  );
}

export async function refreshGoogleAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
  let result: {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  try {
    const response = await axios.post<typeof result>(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    result = response.data;
  } catch (error) {
    if (!axios.isAxiosError(error) || !error.response) throw error;
    throw new GmailApiError(
      `Google token refresh failed with status ${error.response.status}.`,
      error.response.status,
      responseText(error.response.data),
    );
  }

  if (!result.access_token || !result.expires_in) {
    throw new Error("Google did not return a usable refreshed access token.");
  }

  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in,
    scope: result.scope,
  };
}
