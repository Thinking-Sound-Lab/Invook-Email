import type { AcceptedMailboxSyncResponse } from "@invook/contracts";
import axios from "axios";

export async function requestMailboxSync(): Promise<void> {
  await axios.post<AcceptedMailboxSyncResponse>("/v1/mailbox/sync");
}
