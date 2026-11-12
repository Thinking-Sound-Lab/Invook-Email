import {
  gmailSystemLabels,
  type GmailHistoryChange,
} from "@invook/gmail";

export type CoalescedGmailMessageHistoryAction = {
  action: GmailHistoryChange["action"];
  providerHistoryId: string | null;
  gmailLabels: ReturnType<typeof gmailSystemLabels> | null;
  isDraftRelated: boolean;
};

/**
 * History.list returns every record in a catch-up window. Gmail emits
 * `messagesDeleted` and a later `messagesAdded` for the same id when a
 * permanent delete or draft discard is undone, so the latest record owns the
 * action. Same-record label-plus-delete still collapses to delete in
 * `gmailHistoryChanges` before this merge runs.
 */
export function coalesceGmailMessageHistoryAction(
  current: CoalescedGmailMessageHistoryAction | undefined,
  change: GmailHistoryChange,
  providerHistoryId: string | null,
): CoalescedGmailMessageHistoryAction {
  return {
    action: change.action,
    providerHistoryId,
    gmailLabels: change.providerLabelIds
      ? gmailSystemLabels(change.providerLabelIds)
      : current?.gmailLabels ?? null,
    isDraftRelated: change.isDraftRelated || (current?.isDraftRelated ?? false),
  };
}
