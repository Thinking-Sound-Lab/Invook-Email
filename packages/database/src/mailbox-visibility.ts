import type { MailboxView, StaticMailboxView } from "@invook/contracts";
import { sql } from "drizzle-orm";

import {
  labels,
  messageLabels,
  messages,
  threadLabelAssignments,
  threads,
} from "./schema";

export const MAILBOX_PAGE_SIZE = 100;

const gmailProviderLabelByMailboxView = {
  starred: "STARRED",
  drafts: "DRAFT",
  sent: "SENT",
  spam: "SPAM",
  trash: "TRASH",
} as const satisfies Record<
  Exclude<StaticMailboxView, "all" | "important">,
  string
>;

export const countedGmailProviderLabelIds = Object.values(
  gmailProviderLabelByMailboxView,
);

export function inboxThreadCondition() {
  return sql<boolean>`exists (
    select 1 from ${messages} inbox_message
    where inbox_message.thread_id = ${threads.id}
      and exists (
        select 1 from ${messageLabels} inbox_membership
        inner join ${labels} inbox_label on inbox_label.id = inbox_membership.label_id
        where inbox_membership.message_id = inbox_message.id
          and inbox_label.kind = 'gmail'
          and inbox_label.provider_label_id = 'INBOX'
      )
      and not exists (
        select 1 from ${messageLabels} excluded_membership
        inner join ${labels} excluded_label on excluded_label.id = excluded_membership.label_id
        where excluded_membership.message_id = inbox_message.id
          and excluded_label.kind = 'gmail'
          and excluded_label.provider_label_id in ('SPAM', 'TRASH')
      )
  )`;
}

export function assignedThreadCondition() {
  return sql<boolean>`exists (
    select 1 from ${threadLabelAssignments} assignment
    where assignment.thread_id = ${threads.id}
  )`;
}

export const visibleMessageCondition = sql<boolean>`(
  exists (
    select 1 from ${threadLabelAssignments} visible_assignment
    where visible_assignment.thread_id = ${messages.threadId}
  )
  or not exists (
    select 1 from ${messages} visible_thread_message
    where visible_thread_message.thread_id = ${messages.threadId}
      and exists (
        select 1 from ${messageLabels} visible_inbox_membership
        inner join ${labels} visible_inbox_label
          on visible_inbox_label.id = visible_inbox_membership.label_id
        where visible_inbox_membership.message_id = visible_thread_message.id
          and visible_inbox_label.kind = 'gmail'
          and visible_inbox_label.provider_label_id = 'INBOX'
      )
      and not exists (
        select 1 from ${messageLabels} visible_excluded_membership
        inner join ${labels} visible_excluded_label
          on visible_excluded_label.id = visible_excluded_membership.label_id
        where visible_excluded_membership.message_id = visible_thread_message.id
          and visible_excluded_label.kind = 'gmail'
          and visible_excluded_label.provider_label_id in ('SPAM', 'TRASH')
      )
  )
)`;

export function visibleThreadCondition() {
  return sql<boolean>`((${assignedThreadCondition()}) or not (${inboxThreadCondition()}))`;
}

export function mailboxViewCondition(view: MailboxView) {
  if (view.startsWith("label:")) {
    const labelId = view.slice(6);
    return sql<boolean>`
      (${inboxThreadCondition()}) and exists (
        select 1 from ${threadLabelAssignments} assignment
        where assignment.thread_id = ${threads.id}
          and assignment.label_id = ${labelId}::uuid
      )
    `;
  }
  switch (view) {
    case "all":
      return sql<boolean>`(${inboxThreadCondition()}) and (${assignedThreadCondition()})`;
    case "important":
      return sql<boolean>`
        (${inboxThreadCondition()}) and exists (
          select 1 from ${threadLabelAssignments} important_assignment
          inner join ${labels} important_label
            on important_label.id = important_assignment.label_id
          where important_assignment.thread_id = ${threads.id}
            and important_label.kind = 'invook'
            and important_label.system_key = 'important'
        )
      `;
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
      )`;
    }
  }
}

export function mailboxViewForProviderLabelId(
  providerLabelId: string | null,
): Exclude<StaticMailboxView, "all"> | null {
  switch (providerLabelId) {
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
