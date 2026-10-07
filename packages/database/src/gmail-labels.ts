import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { DatabaseExecutor } from "./client";
import { labels } from "./schema";

interface GmailLabelReference {
  id: string;
  providerLabelId: string;
}

export async function getOrCreateGmailLabels(
  input: {
    userId: string;
    accountId: string;
    gmailLabels: Array<{ providerLabelId: string; name: string }>;
  },
  database: DatabaseExecutor,
): Promise<GmailLabelReference[]> {
  const requestedLabels = Array.from(
    new Map(input.gmailLabels.map((label) => [label.providerLabelId, label])).values(),
  ).sort((left, right) => left.providerLabelId.localeCompare(right.providerLabelId));
  if (requestedLabels.length === 0) return [];
  const providerLabelIds = requestedLabels.map((label) => label.providerLabelId);
  const readLabels = () => database
    .select({
      id: labels.id,
      providerLabelId: labels.providerLabelId,
      name: labels.name,
      normalizedName: labels.normalizedName,
      providerType: labels.providerType,
    })
    .from(labels)
    .where(and(
      eq(labels.accountId, input.accountId),
      eq(labels.kind, "gmail"),
      inArray(labels.providerLabelId, providerLabelIds),
    ));
  let storedLabels = await readLabels();
  const storedLabelsByProviderId = new Map(
    storedLabels.map((label) => [label.providerLabelId, label]),
  );
  const changedLabels = requestedLabels.filter((label) => {
    const stored = storedLabelsByProviderId.get(label.providerLabelId);
    return !stored || stored.name !== label.name
      || stored.normalizedName !== label.name.toLowerCase()
      || stored.providerType !== "system";
  });
  // Unconditional conflict updates lock shared labels such as INBOX until the
  // whole message transaction commits, serializing otherwise unrelated threads.
  if (changedLabels.length > 0) {
    await database.insert(labels).values(changedLabels.map((label) => ({
      userId: input.userId,
      accountId: input.accountId,
      kind: "gmail" as const,
      providerLabelId: label.providerLabelId,
      name: label.name,
      normalizedName: label.name.toLowerCase(),
      description: "",
      providerType: "system" as const,
    }))).onConflictDoUpdate({
      target: [labels.accountId, labels.providerLabelId],
      targetWhere: isNotNull(labels.providerLabelId),
      set: {
        name: sql`excluded.name`,
        normalizedName: sql`excluded.normalized_name`,
        providerType: "system",
        updatedAt: new Date(),
      },
    });
    storedLabels = await readLabels();
  }
  return storedLabels.flatMap((label) => label.providerLabelId
    ? [{ id: label.id, providerLabelId: label.providerLabelId }]
    : []);
}
