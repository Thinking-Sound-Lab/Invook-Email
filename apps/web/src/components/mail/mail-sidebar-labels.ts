import type { GmailUserLabel, InvookLabel } from "@invook/contracts";

export interface SidebarLabel {
  id: string;
  name: string;
  kind: "gmail" | "invook";
}

export function listSidebarLabels(input: {
  gmailUserLabels: GmailUserLabel[];
  invookLabels: InvookLabel[];
}): SidebarLabel[] {
  const labels: SidebarLabel[] = [
    ...input.gmailUserLabels.map((label) => ({
      id: label.id,
      name: label.name,
      kind: "gmail" as const,
    })),
    ...input.invookLabels.map((label) => ({
      id: label.id,
      name: label.name,
      kind: "invook" as const,
    })),
  ];
  return labels.sort((left, right) => left.name.localeCompare(right.name));
}
