export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  mailSync: AccountSyncStage;
  indexing: AccountSyncStage;
  memory: AccountSyncStage;
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

export type MailboxMessage = {
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
  attachments: Array<{
    providerAttachmentId: string | null;
    filename: string;
    mimeType: string | null;
    size: number | null;
  }>;
};
