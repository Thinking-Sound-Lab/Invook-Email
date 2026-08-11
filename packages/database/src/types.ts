export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  recent: AccountSyncStage;
  memory: AccountSyncStage;
  history: AccountSyncStage;
};

export type ClaimedJob = {
  id: string;
  userId: string | null;
  accountId: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

export type IndexedMessage = {
  userId: string;
  accountId: string;
  providerThreadId: string;
  providerMessageId: string;
  subject: string;
  snippet: string;
  participants: string[];
  labelIds: string[];
  sentAt: Date;
  direction: "incoming" | "outgoing";
  sender: { raw: string; email: string };
  recipients: string[];
  bodyText: string;
  isMemoryEligible: boolean;
  ingestionMode: "initial" | "incremental";
  memoryContactEmails: string[];
};
