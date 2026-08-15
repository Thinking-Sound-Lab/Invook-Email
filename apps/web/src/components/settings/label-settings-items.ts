import type { GmailUserLabel, InvookLabel } from "@invook/contracts";

export type LabelSettingsItem =
  | { kind: "gmail"; label: GmailUserLabel }
  | { kind: "invook"; label: InvookLabel };

export function listLabelSettingsItems(input: {
  gmailUserLabels: GmailUserLabel[];
  invookLabels: InvookLabel[];
}): LabelSettingsItem[] {
  const items: LabelSettingsItem[] = [
    ...input.gmailUserLabels.map((label) => ({
      kind: "gmail" as const,
      label,
    })),
    ...input.invookLabels.map((label) => ({
      kind: "invook" as const,
      label,
    })),
  ];

  return items.sort((left, right) => {
    const nameComparison = left.label.name.localeCompare(right.label.name);
    return nameComparison || left.kind.localeCompare(right.kind);
  });
}
