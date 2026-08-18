import type { MailboxView, StaticMailboxView } from "@invook/contracts";
import { inArray, sql } from "drizzle-orm";

import {
  labels,
  messageLabels,
  messages,
  threads,
} from "./schema";
import { visibleMessageLabelAnalysisStates } from "./message-label-analysis";

export const MAILBOX_PAGE_SIZE = 100;

const gmailProviderLabelByMailboxView = {
  important: "IMPORTANT",
  starred: "STARRED",
  drafts: "DRAFT",
  sent: "SENT",
  spam: "SPAM",
  trash: "TRASH",
} as const satisfies Record<Exclude<StaticMailboxView, "all">, string>;

export const countedGmailProviderLabelIds = Object.values(
  gmailProviderLabelByMailboxView,
);

export const visibleMessageCondition = inArray(
  messages.labelAnalysisState,
  visibleMessageLabelAnalysisStates,
);

export function visibleThreadCondition() {
  return sql<boolean>`exists (
    select 1
    from ${messages} visible_message
    where visible_message.thread_id = ${threads.id}
      and visible_message.label_analysis_state in ('complete', 'failed')
  )`;
}

export function mailboxViewCondition(view: MailboxView) {
  if (view.startsWith("label:")) {
    const labelId = view.slice(6);
    return sql<boolean>`exists (
      select 1
      from ${messages}
      inner join ${messageLabels} on ${messageLabels.messageId} = ${messages.id}
      where ${messages.threadId} = ${threads.id}
        and ${messageLabels.labelId} = ${labelId}::uuid
        and ${messages.labelAnalysisState} in ('complete', 'failed')
    )`;
  }
  switch (view) {
    case "all":
      return undefined;
    case "important":
    case "starred":
    case "drafts":
    case "sent":
    case "spam":
    case "trash": {
      const providerLabelId = gmailProviderLabelByMailboxView[view];
      return sql<boolean>`exists (
        select 1
        from ${messages}
        inner join ${messageLabels}
          on ${messageLabels.messageId} = ${messages.id}
        inner join ${labels}
          on ${labels.id} = ${messageLabels.labelId}
        where ${messages.threadId} = ${threads.id}
          and ${labels.kind} = 'gmail'
          and ${labels.providerLabelId} = ${providerLabelId}
          and ${messages.labelAnalysisState} in ('complete', 'failed')
      )`;
    }
  }
}

export function mailboxViewForProviderLabelId(
  providerLabelId: string | null,
): Exclude<StaticMailboxView, "all"> | null {
  switch (providerLabelId) {
    case "IMPORTANT":
      return "important";
    case "STARRED":
      return "starred";
    case "DRAFT":
      return "drafts";
    case "SENT":
      return "sent";
    case "SPAM":
      return "spam";
    case "TRASH":
      return "trash";
    default:
      return null;
  }
}
