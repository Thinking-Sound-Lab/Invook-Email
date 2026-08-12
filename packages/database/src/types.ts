export type AccountSyncStage = "pending" | "running" | "complete" | "failed";

export type AccountSyncState = {
  mailSync: AccountSyncStage;
  indexing: AccountSyncStage;
  memory: AccountSyncStage;
};

export type WorkflowStepJob = {
  id: string;
  userId: string | null;
  accountId: string | null;
  runId: string | null;
  stepType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

export type QueueName =
  | "gmail-pages"
  | "gmail-messages"
  | "mail-indexing-batch"
  | "mail-indexing-live"
  | "mail-memory-submit"
  | "mail-memory-events"
  | "mail-memory-feedback";

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
