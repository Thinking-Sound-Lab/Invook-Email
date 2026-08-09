export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  recent: AccountSyncStage;
  memory: AccountSyncStage;
  history: AccountSyncStage;
};

export const invookLabelKeys = [
  "important",
  "travel",
  "pitch",
  "newsletter",
] as const;

export type InvookLabelKey = (typeof invookLabelKeys)[number];

export type InvookThreadLabel = {
  key: InvookLabelKey;
  source: "ai" | "user";
  confidence: number | null;
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

export type ReplyDraft = {
  id: string;
  threadId: string;
  status: "editing" | "sent" | "discarded" | "failed";
  generatedText: string;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: string;
};

export type SessionState =
  | { authenticated: false; gmailConnected: false }
  | { authenticated: true; gmailConnected: boolean };

export type MailboxAccount = {
  id: string;
  email: string;
  status: "connected" | "reconnect_required" | "disconnected";
  syncState: AccountSyncState;
  lastSyncedAt: string | null;
};

export type MailboxThreadSummary = {
  id: string;
  subject: string;
  snippet: string;
  participants: string[];
  labelIds: string[];
  invookLabels: InvookThreadLabel[];
  latestMessageAt: string | null;
  messageCount: number;
};

export type MailboxThreadMessage = {
  id: string;
  direction: "incoming" | "outgoing";
  sender: { raw: string; email: string };
  recipients: string[];
  labelIds: string[];
  subject: string;
  bodyText: string;
  sentAt: string;
};

export type MailboxSelectedThread = Omit<MailboxThreadSummary, "snippet"> & {
  messages: MailboxThreadMessage[];
  draft: ReplyDraft | null;
};

export type MailboxWorkspace = {
  aiConfigured: boolean;
  account: MailboxAccount;
  memories: MemoryEntry[];
  threads: MailboxThreadSummary[];
  selectedThread: MailboxSelectedThread | null;
};

export type ApiProblem = {
  type: "about:blank";
  title: string;
  status: number;
  requestId: string;
};
