export * from "./gmail-compose";

export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export const MAIL_EMBEDDING_DIMENSIONS = 1_536;

export type AccountSyncState = {
  mailSync: AccountSyncStage;
  indexing: AccountSyncStage;
  memory: AccountSyncStage;
};

export type IndexingProgress = {
  state: AccountSyncStage;
  completedMessageCount: number;
  failedMessageCount: number;
  totalMessageCount: number;
};

export type IndexingStatusEvent = IndexingProgress;

export const mailboxViews = [
  "all",
  "travel",
  "important",
  "pitch",
  "newsletter",
  "starred",
  "drafts",
  "sent",
  "trash",
] as const;

export type MailboxView = (typeof mailboxViews)[number] | `label:${string}`;

export type MemoryGenerationProgress = {
  stage:
    | "waiting_for_mail"
    | "preparing"
    | "validating"
    | "analyzing"
    | "finalizing"
    | "complete"
    | "failed";
  completedRequestCount: number | null;
  failedRequestCount: number | null;
  totalRequestCount: number | null;
  evidenceMessageCount: number | null;
  memoryCount: number;
};

export const systemLabelKeys = [
  "important",
  "travel",
  "pitch",
  "newsletter",
] as const;

export type SystemLabelKey = (typeof systemLabelKeys)[number];

export const systemLabelDefinitions = [
  {
    key: "important",
    name: "Important",
    description:
      "Requires timely attention, a reply, a decision, or has meaningful financial, legal, security, or personal consequence. Routine bulk mail does not belong here.",
  },
  {
    key: "travel",
    name: "Travel",
    description:
      "Bookings, itineraries, tickets, lodging, visas, check-in, transport, or trip changes.",
  },
  {
    key: "pitch",
    name: "Pitch",
    description:
      "Sales, recruiting, partnership, fundraising, investment, sponsorship, or service proposals.",
  },
  {
    key: "newsletter",
    name: "Newsletter",
    description:
      "Recurring editorial, digest, product-update, community-update, or marketing publications sent in bulk.",
  },
] as const satisfies ReadonlyArray<{
  key: SystemLabelKey;
  name: string;
  description: string;
}>;

export type LabelAnalysisState = "pending" | "running" | "complete" | "failed";

export type MailLabel = {
  id: string;
  name: string;
  description: string;
  systemKey: SystemLabelKey | null;
  definitionVersion: number;
  analysisState: LabelAnalysisState;
  analyzedThreadCount: number;
  totalThreadCount: number;
};

export type CreateMailLabelRequest = {
  name: string;
  description: string;
};

export type MailLabelResponse = {
  label: MailLabel;
};

export type InvookThreadLabel = {
  labelId: string;
  name: string;
  systemKey: SystemLabelKey | null;
  source: "ai" | "user";
  confidence: number | null;
};

export type SetThreadLabelRequest = {
  labelId: string;
  applied: boolean;
};

export type ThreadLabelsResponse = {
  labels: InvookThreadLabel[];
};

export const memoryTypes = ["preference", "contact", "scheduling"] as const;

export type MemoryType = (typeof memoryTypes)[number];
export type MemorySource = "user" | "inferred" | "feedback";

export type MemoryEntry = {
  id: string;
  type: MemoryType;
  contactEmail: string | null;
  statement: string;
  source: MemorySource;
  confidence: number | null;
  evidenceMessageIds: string[];
  evidenceDraftIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SaveMemoryRequest = {
  type: MemoryType;
  contactEmail: string | null;
  statement: string;
};

export type MemoryEntryResponse = {
  memory: MemoryEntry;
};

export type AiReplyDraft = {
  id: string;
  threadId: string;
  status: "editing" | "sent" | "discarded" | "failed";
  generatedText: string;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: string;
};

export type CreateAiReplyDraftRequest = {
  instruction?: string;
};

export type UpdateAiReplyDraftRequest = {
  currentText: string;
};

export type AiReplyDraftResponse = {
  draft: AiReplyDraft;
};

export type AcceptedMailboxSyncResponse = {
  accepted: true;
  stepId: string;
};

export type DeletedResourceResponse = {
  deleted: true;
};

export type SessionState =
  | { authenticated: false; gmailConnected: false }
  | { authenticated: true; gmailConnected: boolean };

export type MailboxAccount = {
  id: string;
  email: string;
  status: "connected" | "reconnect_required" | "disconnected";
  syncState: AccountSyncState;
  indexingProgress: IndexingProgress;
  lastSyncedAt: string | null;
  replica: {
    state:
      | "pending"
      | "snapshotting"
      | "replaying"
      | "auditing"
      | "ready"
      | "repairing"
      | "failed"
      | "deleting";
    readyAt: string | null;
    lastAuditAt: string | null;
  };
};

export type GmailLabel = {
  id: string;
  providerLabelId: string;
  name: string;
  type: "system" | "user";
  color: { textColor?: string; backgroundColor?: string } | null;
};

export type GmailDraftResource = {
  id: string;
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
  updatedAt: string;
};

export type MailboxThreadSummary = {
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  gmailLabels: GmailLabel[];
  invookLabels: InvookThreadLabel[];
  latestMessageAt: string | null;
  messageCount: number;
};

export type MailboxThreadMessage = {
  id: string;
  direction: "incoming" | "outgoing";
  sender: { raw: string; email: string };
  recipients: string[];
  providerMessageId: string;
  providerHistoryId: string | null;
  internalDate: string;
  sizeEstimate: number | null;
  headers: Array<{ name: string; value: string }>;
  gmailLabels: GmailLabel[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  rawMime: {
    checksumSha256: string;
    contentLength: number;
  } | null;
  sentAt: string;
  attachments: MailboxAttachment[];
};

export type MailboxAttachment = {
  id: string;
  messageId: string;
  providerAttachmentId: string | null;
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentId: string | null;
  contentDisposition: string | null;
  checksumSha256: string | null;
  contentLength: number | null;
};

export type MailSearchMatch =
  | "full_text"
  | "metadata"
  | "attachment"
  | "semantic";

export type MailSearchResult = {
  messageId: string;
  threadId: string;
  subject: string;
  snippet: string;
  bodyPreview: string;
  sender: { raw: string; email: string };
  sentAt: string;
  attachments: MailboxAttachment[];
  matches: MailSearchMatch[];
  score: number;
};

export const mailboxActionOperations = [
  "archive",
  "mark_read",
  "mark_unread",
  "trash",
  "apply_gmail_label",
  "remove_gmail_label",
  "save_draft_to_gmail",
] as const;

export type MailboxActionOperation = (typeof mailboxActionOperations)[number];

export type MailboxActionStatus =
  | "pending"
  | "executing"
  | "completed"
  | "partial_failure"
  | "failed"
  | "cancelled";

export type MailboxActionTargetStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "stale";

export type MailboxActionTarget = {
  id: string;
  messageId: string | null;
  draftId: string | null;
  threadId: string;
  subject: string;
  sender: string | null;
  sentAt: string | null;
  status: MailboxActionTargetStatus;
  errorCode: string | null;
};

export type MailboxActionProposal = {
  id: string;
  operation: MailboxActionOperation;
  status: MailboxActionStatus;
  gmailLabel: { id: string; name: string } | null;
  targets: MailboxActionTarget[];
  createdAt: string;
  approvedAt: string | null;
  completedAt: string | null;
};

export type MailboxQueryMessage = {
  messageId: string;
  threadId: string;
  subject: string;
  sender: { raw: string; email: string };
  sentAt: string;
  bodyPreview: string;
  isInbox: boolean;
  isUnread: boolean;
  gmailLabels: Array<{ id: string; name: string }>;
  invookLabels: Array<{ id: string; name: string }>;
};

export type MailboxQueryResult =
  | {
      status: "available";
      messages: MailboxQueryMessage[];
      availableGmailLabels: Array<{ id: string; name: string }>;
      availableInvookLabels: Array<{ id: string; name: string }>;
      nextCursor: string | null;
    }
  | {
      status: "unavailable";
      reason: "replica_not_ready" | "mailbox_not_connected";
      messages: [];
      availableGmailLabels?: never;
      availableInvookLabels?: never;
      nextCursor: null;
    };

export type MailboxSelectedThread = Omit<MailboxThreadSummary, "snippet"> & {
  messages: MailboxThreadMessage[];
  aiReplyDraft: AiReplyDraft | null;
  gmailDrafts: GmailDraftResource[];
};

export type MailboxPagination = {
  newerCursor: string | null;
  olderCursor: string | null;
  totalThreadCount: number;
};

export type MailboxWorkspace = {
  aiConfigured: boolean;
  batchConfigured: boolean;
  account: MailboxAccount;
  memoryProgress: MemoryGenerationProgress;
  memories: MemoryEntry[];
  labels: MailLabel[];
  pagination: MailboxPagination;
  threads: MailboxThreadSummary[];
  selectedThread: MailboxSelectedThread | null;
};

export type ApiProblem = {
  type: "about:blank";
  title: string;
  status: number;
  requestId: string;
};

export type MailboxChangeEvent = {
  id: string;
  accountId: string;
  changeType:
    | "replica_ready"
    | "history_applied"
    | "repair_complete"
    | "drafts_changed"
    | "labels_changed";
  createdAt: string;
};
