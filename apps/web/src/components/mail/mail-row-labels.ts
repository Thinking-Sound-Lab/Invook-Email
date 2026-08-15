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
  const importantLabels = thread.gmailLabels.flatMap((label) =>
      label.providerLabelId === "IMPORTANT"
        ? [{ id: label.id, kind: "gmail" as const, name: label.name }]
        : [],
    );
  const invookLabels = thread.invookLabels.map((label) => ({
      id: label.labelId,
      kind: "invook" as const,
      name: label.name,
    }));
  const labels: MailRowLabel[] = [
    ...importantLabels,
    ...invookLabels,
    ...(thread.isOthers && importantLabels.length === 0 && invookLabels.length === 0
      ? [{ id: "others", kind: "derived" as const, name: "Others" }]
      : []),
  ];

  return labels.sort((left, right) => left.name.localeCompare(right.name));
}
