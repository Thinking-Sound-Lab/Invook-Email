import { GmailApiError } from "@invook/gmail";

export async function applyGmailHistoryWithExpiredCursorRepair<
  AppliedResult,
  RepairedResult,
>(input: {
  apply: () => Promise<AppliedResult>;
  repair: () => Promise<RepairedResult>;
}): Promise<
  | { outcome: "applied"; result: AppliedResult }
  | { outcome: "repaired"; result: RepairedResult }
> {
  try {
    return { outcome: "applied", result: await input.apply() };
  } catch (error) {
    if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
    return { outcome: "repaired", result: await input.repair() };
  }
}
