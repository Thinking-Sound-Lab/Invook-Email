import type { MailboxThreadSummary } from "@invook/contracts";

export interface MailRowLabel {
  id: string;
  kind: "invook";
  name: string;
}

export function listMailRowLabels(
  thread: Pick<MailboxThreadSummary, "invookLabel">,
): MailRowLabel[] {
  return thread.invookLabel
    ? [{
        id: thread.invookLabel.labelId,
        kind: "invook",
        name: thread.invookLabel.name,
      }]
    : [];
}
