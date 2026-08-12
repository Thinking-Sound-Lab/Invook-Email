import type {
  MailboxAccount,
  MailboxSelectedThread,
  MailboxThreadMessage,
  MailboxThreadSummary,
  MailboxView as ContractMailboxView,
} from "@invook/contracts";

export type MailboxView = ContractMailboxView;

export type MailSurface = "mail" | "compose" | "search" | "settings" | "automations";

export type MailThreadSummary = MailboxThreadSummary;
export type ThreadMessage = MailboxThreadMessage;
export type SelectedThread = MailboxSelectedThread;
export type MailAccount = MailboxAccount;
