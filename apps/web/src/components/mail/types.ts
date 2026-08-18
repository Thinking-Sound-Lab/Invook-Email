import type {
  MailboxSelectedThread,
  MailboxThreadSummary,
  MailboxView as ContractMailboxView,
} from "@invook/contracts";

export type StaticMailboxView = Exclude<
  ContractMailboxView,
  `label:${string}`
>;

export type MailboxView = ContractMailboxView | `label:${string}`;

export type MailSurface = "mail" | "compose" | "search" | "automations";

export type MailThreadSummary = MailboxThreadSummary;
export type SelectedThread = MailboxSelectedThread;
