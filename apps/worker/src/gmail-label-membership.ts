export type GmailLabelMembershipSnapshot = {
  providerMessageId: string;
  providerLabelIds: string[];
};

export type GmailLabelMembershipMismatch = {
  providerMessageId: string;
  providerLabelIds: string[];
  storedLabelIds: string[];
};

function normalizedLabelIds(labelIds: string[]): string[] {
  return Array.from(new Set(labelIds)).sort((left, right) => left.localeCompare(right));
}

export function findGmailLabelMembershipMismatches(
  providerMemberships: GmailLabelMembershipSnapshot[],
  storedMemberships: GmailLabelMembershipSnapshot[],
): GmailLabelMembershipMismatch[] {
  const storedByMessageId = new Map(
    storedMemberships.map((membership) => [
      membership.providerMessageId,
      normalizedLabelIds(membership.providerLabelIds),
    ]),
  );

  return providerMemberships.flatMap((membership) => {
    const providerLabelIds = normalizedLabelIds(membership.providerLabelIds);
    const storedLabelIds = storedByMessageId.get(membership.providerMessageId) ?? [];
    if (
      providerLabelIds.length === storedLabelIds.length &&
      providerLabelIds.every((providerLabelId, index) => providerLabelId === storedLabelIds[index])
    ) {
      return [];
    }
    return [
      {
        providerMessageId: membership.providerMessageId,
        providerLabelIds,
        storedLabelIds,
      },
    ];
  });
}
