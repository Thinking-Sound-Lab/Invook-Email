import type {
  CreateInvookLabelRequest,
  DeletedResourceResponse,
  InvookLabel,
  InvookLabelResponse,
  InvookThreadLabel,
  SetThreadLabelRequest,
  ThreadLabelsResponse,
} from "@invook/contracts";
import axios from "axios";

export async function createInvookLabel(
  input: CreateInvookLabelRequest,
): Promise<InvookLabel> {
  const response = await axios.post<InvookLabelResponse>("/v1/labels", input);
  return response.data.label;
}

export async function deleteInvookLabel(labelId: string): Promise<void> {
  await axios.delete<DeletedResourceResponse>(`/v1/labels/${labelId}`);
}

export async function deleteGmailUserLabel(gmailLabelId: string): Promise<void> {
  await axios.delete<DeletedResourceResponse>(`/v1/gmail/labels/${gmailLabelId}`);
}

export interface SetThreadLabelInput extends SetThreadLabelRequest {
  threadId: string;
}

export async function setThreadLabel({
  threadId,
  labelId,
  applied,
}: SetThreadLabelInput): Promise<InvookThreadLabel[]> {
  const request: SetThreadLabelRequest = { labelId, applied };
  const response = await axios.patch<ThreadLabelsResponse>(
    `/v1/threads/${threadId}/labels`,
    request,
  );
  return response.data.labels;
}
