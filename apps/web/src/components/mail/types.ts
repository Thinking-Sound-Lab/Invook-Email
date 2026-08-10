import type {
  MailboxAccount,
  MailboxSelectedThread,
  MailboxThreadMessage,
  MailboxThreadSummary,
} from "@invook/contracts";

export type StaticMailboxView =
  | "all"
  | "starred"
  | "shared"
  | "reminders"
  | "scheduled"
  | "drafts"
  | "done"
  | "sent"
  | "trash";

export type MailboxView = StaticMailboxView | `label:${string}`;

export type MailSurface = "mail" | "compose" | "search" | "settings" | "automations";

export type MailThreadSummary = MailboxThreadSummary;
export type ThreadMessage = MailboxThreadMessage;
export type SelectedThread = MailboxSelectedThread;
export type MailAccount = MailboxAccount;
