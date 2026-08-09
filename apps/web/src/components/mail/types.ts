import type {
  MailboxAccount,
  MailboxSelectedThread,
  MailboxThreadMessage,
  MailboxThreadSummary,
} from "@invook/contracts";

export type MailboxView =
  | "all"
  | "travel"
  | "important"
  | "pitch"
  | "newsletter"
  | "starred"
  | "shared"
  | "reminders"
  | "scheduled"
  | "drafts"
  | "done"
  | "sent"
  | "trash";

export type MailSurface = "mail" | "compose" | "search" | "settings" | "automations";

export type MailThreadSummary = MailboxThreadSummary;
export type ThreadMessage = MailboxThreadMessage;
export type SelectedThread = MailboxSelectedThread;
export type MailAccount = MailboxAccount;
