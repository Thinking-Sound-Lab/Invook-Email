export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  recent: AccountSyncStage;
  memory: AccountSyncStage;
  history: AccountSyncStage;
};

export type MemoryGenerationProgress = {
  stage:
    | "indexing"
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

export type InvookThreadLabel = {
  labelId: string;
  name: string;
  systemKey: SystemLabelKey | null;
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
  batchConfigured: boolean;
  account: MailboxAccount;
  memoryProgress: MemoryGenerationProgress;
  memories: MemoryEntry[];
  labels: MailLabel[];
  threads: MailboxThreadSummary[];
  selectedThread: MailboxSelectedThread | null;
};

export type ApiProblem = {
  type: "about:blank";
  title: string;
  status: number;
  requestId: string;
};
