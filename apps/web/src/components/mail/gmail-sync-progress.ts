import type { MailSyncProgress } from "@invook/contracts";

export interface GmailSyncProgressPresentation {
  title: string;
  detail: string;
  percentage: number | null;
  isFailed: boolean;
}

export function getGmailSyncProgressPresentation(
  progress: MailSyncProgress,
): GmailSyncProgressPresentation | null {
  if (progress.state === "complete") return null;

  const isFailed = progress.state === "failed";
  const percentage = progress.discoveredMessageCount === 0
    ? progress.discoveryComplete
      ? 100
      : null
    : Math.min(
        100,
        Math.round(
          (progress.processedMessageCount / progress.discoveredMessageCount) * 100,
        ),
      );

  if (isFailed) {
    const failedDetail = progress.failedMessageCount
      ? `; ${progress.failedMessageCount.toLocaleString()} failed`
      : "";
    return {
      title: "Gmail sync needs attention",
      detail: `${progress.processedMessageCount.toLocaleString()} messages synced${failedDetail}`,
      percentage,
      isFailed,
    };
  }

  if (!progress.discoveryComplete) {
    const isProcessing = progress.processedMessageCount > 0;
    return {
      title:
        isProcessing
          ? "Finding and syncing Gmail"
          : progress.discoveredMessageCount > 0
          ? "Finding Gmail messages"
          : "Preparing Gmail sync",
      detail:
        isProcessing
          ? `${progress.processedMessageCount.toLocaleString()} of ${progress.discoveredMessageCount.toLocaleString()} discovered messages synced`
          : progress.discoveredMessageCount > 0
          ? `${progress.discoveredMessageCount.toLocaleString()} messages found so far`
          : "Waiting for Gmail to report message totals",
      percentage,
      isFailed,
    };
  }

  return {
    title: "Syncing Gmail",
    detail:
      progress.discoveredMessageCount === 0
        ? "Finishing an empty mailbox sync"
        : `${progress.processedMessageCount.toLocaleString()} of ${progress.discoveredMessageCount.toLocaleString()} messages synced`,
    percentage,
    isFailed,
  };
}
