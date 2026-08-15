export type GmailHistoryCatchupDisposition =
  | "complete"
  | "continue_durably"
  | "superseded";

export function gmailHistoryCatchupDisposition(input: {
  applied: boolean;
  pendingHistoryCursor: string | null;
}): GmailHistoryCatchupDisposition {
  if (!input.applied) return "superseded";
  return input.pendingHistoryCursor ? "continue_durably" : "complete";
}
