import type { InvookLabel } from "@invook/contracts";

export interface LabelSettingsItem {
  label: InvookLabel;
  isDeletable: boolean;
}

export function listLabelSettingsItems(
  invookLabels: InvookLabel[],
): LabelSettingsItem[] {
  return invookLabels
    .map((label) => ({
      label,
      isDeletable: label.systemKey === null,
    }))
    .sort((left, right) => left.label.name.localeCompare(right.label.name));
}
