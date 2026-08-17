import type {
  GmailThreadReadStateResponse,
  SetGmailThreadReadStateRequest,
} from "@invook/contracts";
import axios from "axios";

export async function markGmailThreadRead(threadId: string): Promise<void> {
  const request: SetGmailThreadReadStateRequest = { isRead: true };
  await axios.put<GmailThreadReadStateResponse>(
    `/v1/gmail/threads/${encodeURIComponent(threadId)}/read-state`,
    request,
  );
}
