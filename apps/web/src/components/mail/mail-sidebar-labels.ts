import type { InvookLabel } from "@invook/contracts";

export interface SidebarLabel {
  id: string;
  name: string;
}

export function listSidebarLabels(invookLabels: InvookLabel[]): SidebarLabel[] {
  const labels = invookLabels.flatMap((label) =>
    label.systemKey === "important"
      ? []
      : [{ id: label.id, name: label.name }],
  );
  return labels.sort((left, right) => left.name.localeCompare(right.name));
}
