import axios from "axios";

import type { MailboxShell } from "@invook/contracts";

export async function getMailboxShell(signal?: AbortSignal): Promise<MailboxShell> {
  const response = await axios.get<MailboxShell>("/v1/mailbox/shell", { signal });
  return response.data;
}
