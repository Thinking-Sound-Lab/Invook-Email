import type { InvookLabel } from "@invook/contracts";

export interface SidebarLabel {
  id: string;
  name: string;
}

export function listSidebarLabels(invookLabels: InvookLabel[]): SidebarLabel[] {
  const labels = invookLabels.map((label) => ({
    id: label.id,
    name: label.name,
  }));
  return labels.sort((left, right) => left.name.localeCompare(right.name));
}
