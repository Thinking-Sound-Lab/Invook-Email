import axios, {
  type AxiosError,
  type AxiosRequestConfig,
  type Method,
} from "axios";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_MESSAGE_LIST_MAX_RESULTS = 500;
export const GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE =
  "provider_authentication_failed";

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

/** The lossless representation returned by Gmail's messages.get format=raw. */
export type GmailMessageState = GmailMessageReference & {
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
};

export type GmailRawMessage = GmailMessageState & {
  raw: string;
};

export type GmailMessagePage = {
  messages?: GmailMessageReference[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailHistoryChange = {
  messageId: string;
  action: "upsert" | "delete";
};

export type GmailHistoryRecord = {
  id: string;
  messagesAdded?: Array<{ message: GmailMessageReference }>;
  messagesDeleted?: Array<{ message: GmailMessageReference }>;
  labelsAdded?: Array<{
    message: GmailMessageReference;
    labelIds: string[];
  }>;
  labelsRemoved?: Array<{
    message: GmailMessageReference;
    labelIds: string[];
  }>;
};

export type GmailHistoryPage = {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
};

export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
  messageListVisibility?: "hide" | "show";
  labelListVisibility?: "labelHide" | "labelShow" | "labelShowIfUnread";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: {
    textColor?: string;
    backgroundColor?: string;
  };
};

export type GmailLabelInput = {
  name: string;
  messageListVisibility?: "hide" | "show";
  labelListVisibility?: "labelHide" | "labelShow" | "labelShowIfUnread";
  color?: {
    textColor: string;
    backgroundColor: string;
  };
};

export type GmailDraftReference = {
  id: string;
  message: GmailMessageReference;
};

export type GmailDraft = {
  id: string;
  message: GmailRawMessage;
};

export type GmailDraftPage = {
  drafts?: GmailDraftReference[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailDraftWrite = {
  raw: Buffer;
  threadId?: string;
};

export type GmailWatchResponse = {
  historyId: string;
  /** Milliseconds since Unix epoch, represented by Gmail as a decimal string. */
  expiration: string;
};

type GoogleApiErrorPayload = {
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string }>;
      };
  error_description?: string;
};

export class GmailApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly responseData: unknown;
  readonly method: string | null;
  readonly path: string | null;
  readonly code: string | null;
  readonly reason: string | null;
  readonly retryAfter: string | null;

  constructor(
    message: string,
    status: number,
    responseBody: string,
    details: {
      responseData?: unknown;
      method?: string;
      path?: string;
      code?: string;
      reason?: string;
      retryAfter?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "GmailApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.responseData = details.responseData;
    this.method = details.method ?? null;
    this.path = details.path ?? null;
    this.code = details.code ?? null;
    this.reason = details.reason ?? null;
    this.retryAfter = details.retryAfter ?? null;
  }

  static fromAxiosError(
    error: AxiosError,
    context: { operation: string; method?: string; path?: string },
  ): GmailApiError {
    const status = error.response?.status ?? 0;
    const data = error.response?.data;
    const payload = isRecord(data) ? (data as GoogleApiErrorPayload) : undefined;
    const googleError =
      payload?.error && typeof payload.error === "object"
        ? payload.error
        : undefined;
    const oauthCode = typeof payload?.error === "string" ? payload.error : undefined;
    const responseMessage = googleError?.message ?? payload?.error_description;
    const statusDescription = status > 0 ? ` with status ${status}` : "";
    const message = responseMessage
      ? `${context.operation} failed${statusDescription}: ${responseMessage}`
      : `${context.operation} failed${statusDescription}.`;

    return new GmailApiError(message, status, responseText(data ?? error.message), {
      responseData: data,
      method: context.method ?? error.config?.method?.toUpperCase(),
      path: context.path ?? error.config?.url,
      code: googleError?.status ?? oauthCode,
      reason: googleError?.errors?.find((entry) => entry.reason)?.reason,
      retryAfter: headerText(error.response?.headers?.["retry-after"]),
      cause: error,
    });
  }
}

export function isGoogleReauthenticationRequired(error: unknown): boolean {
  if (!(error instanceof GmailApiError)) return false;
  if (error.status === 401) return true;
  return error.path === GOOGLE_TOKEN_ENDPOINT && error.code === "invalid_grant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function headerText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function responseText(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

async function gmailRequest<T>(
  accessToken: string,
  path: string,
  options: {
    method?: Method;
    data?: unknown;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const config: AxiosRequestConfig = {
    baseURL: GMAIL_API_BASE_URL,
    url: path,
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  };
  if (options.data !== undefined) config.data = options.data;

  try {
    const response = await axios.request<T>(config);
    return response.data;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;
    throw GmailApiError.fromAxiosError(error, {
      operation: "Gmail API request",
      method,
      path,
    });
  }
}

export function gmailHistoryChanges(
  record: GmailHistoryRecord,
): GmailHistoryChange[] {
  const changes = new Map<string, GmailHistoryChange["action"]>();
  for (const { message } of record.messagesAdded ?? []) {
    changes.set(message.id, "upsert");
  }
  for (const { message } of record.labelsAdded ?? []) {
    changes.set(message.id, "upsert");
  }
  for (const { message } of record.labelsRemoved ?? []) {
    changes.set(message.id, "upsert");
  }
  for (const { message } of record.messagesDeleted ?? []) {
    changes.set(message.id, "delete");
  }
  return [...changes].map(([messageId, action]) => ({ messageId, action }));
}

export function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  return gmailRequest<GmailProfile>(accessToken, "/users/me/profile");
}

export function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailRawMessage> {
  const search = new URLSearchParams({ format: "raw" });
  return gmailRequest<GmailRawMessage>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}?${search.toString()}`,
  );
}

export function getGmailMessageState(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageState> {
  const search = new URLSearchParams({ format: "minimal" });
  return gmailRequest<GmailMessageState>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}?${search.toString()}`,
  );
}

export function listGmailMessages(
  accessToken: string,
  options: {
    labelId?: string;
    pageToken?: string;
  },
): Promise<GmailMessagePage> {
  const search = new URLSearchParams({
    includeSpamTrash: "true",
    maxResults: String(GMAIL_MESSAGE_LIST_MAX_RESULTS),
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
    maxResults: String(options.maxResults),
  });
  if (options.pageToken) search.set("pageToken", options.pageToken);

  return gmailRequest<GmailHistoryPage>(
    accessToken,
    `/users/me/history?${search.toString()}`,
  );
}

export async function listGmailLabels(accessToken: string): Promise<GmailLabel[]> {
  const response = await gmailRequest<{ labels?: GmailLabel[] }>(
    accessToken,
    "/users/me/labels",
  );
  return response.labels ?? [];
}

export function getGmailLabel(
  accessToken: string,
  labelId: string,
): Promise<GmailLabel> {
  return gmailRequest<GmailLabel>(
    accessToken,
    `/users/me/labels/${encodeURIComponent(labelId)}`,
  );
}

export function createGmailLabel(
  accessToken: string,
  label: GmailLabelInput,
): Promise<GmailLabel> {
  return gmailRequest<GmailLabel>(accessToken, "/users/me/labels", {
    method: "POST",
    data: label,
  });
}

export function updateGmailLabel(
  accessToken: string,
  labelId: string,
  changes: Partial<GmailLabelInput>,
): Promise<GmailLabel> {
  return gmailRequest<GmailLabel>(
    accessToken,
    `/users/me/labels/${encodeURIComponent(labelId)}`,
    { method: "PATCH", data: changes },
  );
}

export async function deleteGmailLabel(
  accessToken: string,
  labelId: string,
): Promise<void> {
  await gmailRequest<unknown>(
    accessToken,
    `/users/me/labels/${encodeURIComponent(labelId)}`,
    { method: "DELETE" },
  );
}

export function modifyGmailMessageLabels(
  accessToken: string,
  messageId: string,
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<GmailMessageState> {
  return gmailRequest<GmailMessageState>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    { method: "POST", data: changes },
  );
}

export function trashGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageState> {
  return gmailRequest<GmailMessageState>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}/trash`,
    { method: "POST" },
  );
}

export function untrashGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageState> {
  return gmailRequest<GmailMessageState>(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}/untrash`,
    { method: "POST" },
  );
}

export function listGmailDrafts(
  accessToken: string,
  options: { maxResults: number; pageToken?: string; query?: string },
): Promise<GmailDraftPage> {
  const search = new URLSearchParams({ maxResults: String(options.maxResults) });
  if (options.pageToken) search.set("pageToken", options.pageToken);
  if (options.query) search.set("q", options.query);
  return gmailRequest<GmailDraftPage>(
    accessToken,
    `/users/me/drafts?${search.toString()}`,
  );
}

export function getGmailDraft(
  accessToken: string,
  draftId: string,
): Promise<GmailDraft> {
  const search = new URLSearchParams({ format: "raw" });
  return gmailRequest<GmailDraft>(
    accessToken,
    `/users/me/drafts/${encodeURIComponent(draftId)}?${search.toString()}`,
  );
}

function gmailDraftBody(draft: GmailDraftWrite): {
  message: { raw: string; threadId?: string };
} {
  return {
    message: {
      raw: draft.raw.toString("base64url"),
      ...(draft.threadId ? { threadId: draft.threadId } : {}),
    },
  };
}

export function createGmailDraft(
  accessToken: string,
  draft: GmailDraftWrite,
): Promise<GmailDraft> {
  return gmailRequest<GmailDraft>(accessToken, "/users/me/drafts", {
    method: "POST",
    data: gmailDraftBody(draft),
  });
}

export function updateGmailDraft(
  accessToken: string,
  draftId: string,
  draft: GmailDraftWrite,
): Promise<GmailDraft> {
  return gmailRequest<GmailDraft>(
    accessToken,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { method: "PUT", data: gmailDraftBody(draft) },
  );
}

export async function deleteGmailDraft(
  accessToken: string,
  draftId: string,
): Promise<void> {
  await gmailRequest<unknown>(
    accessToken,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    { method: "DELETE" },
  );
}

export function startGmailWatch(
  accessToken: string,
  options: {
    topicName: string;
    labelIds?: string[];
    labelFilterBehavior?: "include" | "exclude";
  },
): Promise<GmailWatchResponse> {
  return gmailRequest<GmailWatchResponse>(accessToken, "/users/me/watch", {
    method: "POST",
    data: options,
  });
}

export async function stopGmailWatch(accessToken: string): Promise<void> {
  await gmailRequest<unknown>(accessToken, "/users/me/stop", {
    method: "POST",
  });
}

export async function refreshGoogleAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
  type RefreshResponse = {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };

  let result: RefreshResponse;
  try {
    const response = await axios.post<RefreshResponse>(
      GOOGLE_TOKEN_ENDPOINT,
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
    if (!axios.isAxiosError(error)) throw error;
    throw GmailApiError.fromAxiosError(error, {
      operation: "Google token refresh",
      method: "POST",
      path: GOOGLE_TOKEN_ENDPOINT,
    });
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
