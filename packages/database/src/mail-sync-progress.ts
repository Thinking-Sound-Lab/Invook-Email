import type { AccountSyncStage, MailSyncProgress } from "@invook/contracts";

export interface StoredMailSyncProgress {
  discoveryComplete: boolean;
  discoveredMessageCount: number;
  processedMessageCount: number;
  failedMessageCount: number;
}

export function deriveMailSyncProgress(input: {
  state: AccountSyncStage;
  run: StoredMailSyncProgress | null;
}): MailSyncProgress {
  return {
    state: input.state,
    discoveryComplete:
      input.state === "complete" || (input.run?.discoveryComplete ?? false),
    discoveredMessageCount: input.run?.discoveredMessageCount ?? 0,
    processedMessageCount: input.run?.processedMessageCount ?? 0,
    failedMessageCount: input.run?.failedMessageCount ?? 0,
  };
}

export function hasMailSyncPercentageAdvanced(input: {
  discoveryComplete: boolean;
  discoveredMessageCount: number;
  previousProcessedMessageCount: number;
  processedMessageCount: number;
}): boolean {
  if (!input.discoveryComplete || input.discoveredMessageCount <= 0) return false;

  const previousPercentage = Math.floor(
    (input.previousProcessedMessageCount / input.discoveredMessageCount) * 100,
  );
  const percentage = Math.floor(
    (input.processedMessageCount / input.discoveredMessageCount) * 100,
  );
  return percentage > previousPercentage;
}
