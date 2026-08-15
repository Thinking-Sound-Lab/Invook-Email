import type { MailboxThreadSummary } from "@invook/contracts";

export interface MailRowLabel {
  id: string;
  kind: "gmail" | "invook";
  name: string;
}

export function listMailRowLabels(
  thread: Pick<MailboxThreadSummary, "gmailLabels" | "invookLabels">,
): MailRowLabel[] {
  const labels: MailRowLabel[] = [
    ...thread.gmailLabels.flatMap((label) =>
      label.type === "user"
        ? [{ id: label.id, kind: "gmail" as const, name: label.name }]
        : [],
    ),
    ...thread.invookLabels.map((label) => ({
      id: label.labelId,
      kind: "invook" as const,
      name: label.name,
    })),
  ];

  return labels.sort((left, right) => left.name.localeCompare(right.name));
}
