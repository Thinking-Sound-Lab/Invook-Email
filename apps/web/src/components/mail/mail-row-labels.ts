import type { MailboxThreadSummary } from "@invook/contracts";

export interface MailRowLabel {
  id: string;
  kind: "gmail" | "invook" | "derived";
  name: string;
}

export function listMailRowLabels(
  thread: Pick<
    MailboxThreadSummary,
    "gmailLabels" | "invookLabels" | "isOthers"
  >,
): MailRowLabel[] {
  const labels: MailRowLabel[] = [
    ...thread.gmailLabels.flatMap((label) =>
      label.providerLabelId === "IMPORTANT"
        ? [{ id: label.id, kind: "gmail" as const, name: label.name }]
        : [],
    ),
    ...thread.invookLabels.map((label) => ({
      id: label.labelId,
      kind: "invook" as const,
      name: label.name,
    })),
    ...(thread.isOthers
      ? [{ id: "others", kind: "derived" as const, name: "Others" }]
      : []),
  ];

  return labels.sort((left, right) => left.name.localeCompare(right.name));
}
