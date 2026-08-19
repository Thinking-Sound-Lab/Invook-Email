import type { InvookLabel } from "@invook/contracts";

export interface LabelSettingsItem {
  label: InvookLabel;
  canDisable: boolean;
}

export function listLabelSettingsItems(
  invookLabels: InvookLabel[],
): LabelSettingsItem[] {
  return invookLabels
    .map((label) => ({
      label,
      canDisable: label.systemKey !== "others",
    }))
    .sort((left, right) => left.label.name.localeCompare(right.label.name));
}
