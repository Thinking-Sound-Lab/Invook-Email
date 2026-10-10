import axios from "axios";

import { getMailboxThreadDetail, type GetMailboxThreadDetailInput } from "./api/mailbox-threads";
import { useMailboxStore } from "../stores/mailbox/store";
import type { MailboxThreadDetailRead } from "../stores/mailbox/types";

export interface ReadMailboxThreadDetailInput extends GetMailboxThreadDetailInput {
  source: MailboxThreadDetailRead["source"];
}

export async function readMailboxThreadDetail({
  accountSelection,
  threadId,
  signal,
  source,
}: ReadMailboxThreadDetailInput): Promise<void> {
  if (signal?.aborted) return;
  const read = useMailboxStore.getState().startThreadDetailRead({ threadId, source });
  try {
    const detail = await getMailboxThreadDetail({ accountSelection, threadId, signal });
    if (!signal?.aborted) {
      useMailboxStore.getState().completeThreadDetailRead({ read, result: { loadState: "available", detail } });
    }
  } catch (cause: unknown) {
    if (signal?.aborted || axios.isCancel(cause)) throw cause;
    const isMissing = axios.isAxiosError(cause) && cause.response?.status === 404;
    useMailboxStore.getState().completeThreadDetailRead({
      read,
      result: { loadState: isMissing ? "missing" : "error" },
    });
    if (!isMissing) throw cause;
  }
}
