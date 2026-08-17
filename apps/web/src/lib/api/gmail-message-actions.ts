import axios from "axios";

export interface SetGmailMessageStarInput {
  messageId: string;
  isStarred: boolean;
}

export async function setGmailMessageStar({
  messageId,
  isStarred,
}: SetGmailMessageStarInput): Promise<void> {
  await axios.post(
    `/v1/gmail/messages/${encodeURIComponent(messageId)}/actions`,
    { action: isStarred ? "star" : "unstar" },
  );
}
