/**
 * A snapshot fetched before Gmail deleted a message is stale when its history
 * id is missing or not newer than the delete. Gmail does not reuse message
 * ids, so a strictly newer history id is the only signal that the delete
 * itself was superseded.
 */
export function isStaleGmailSnapshotAfterDelete(
  incomingHistoryId: string | null | undefined,
  deletedHistoryId: string | null | undefined,
): boolean {
  if (!incomingHistoryId || !deletedHistoryId) return true;
  try {
    return BigInt(incomingHistoryId) <= BigInt(deletedHistoryId);
  } catch {
    return true;
  }
}
