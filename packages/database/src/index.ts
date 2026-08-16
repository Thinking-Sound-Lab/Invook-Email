export {
  createDatabase,
  getDatabase,
  listenForAccountSyncNotifications,
  listenForOutboxNotifications,
  listenForMailboxChangeNotifications,
  withGmailAccountControlLock,
  withRemoteMailImageCacheLock,
  type Database,
} from "./client";
export {
  decryptGoogleCredential,
  encryptGoogleCredential,
  type GoogleCredential,
} from "./credentials";
export * from "./gmail-draft-writes";
export * from "./message-label-analysis";
export * from "./embedding-indexing";
export * from "./mail-sync-progress";
export * from "./mailbox-query";
export * from "./gmail-watch";
export * from "./repositories";
export * from "./replica";
export * from "./schema";
export * from "./text";
export * from "./versions";
export * from "./workflows";
export type {
  AccountSyncStage,
  AccountSyncState,
  IndexedMessage,
  MailboxMessage,
  QueueName,
  WorkflowStepInput,
  WorkflowStepJob,
} from "./types";
