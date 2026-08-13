import type {
  CreateMailLabelRequest,
  DeletedResourceResponse,
  InvookThreadLabel,
  MailLabel,
  MailLabelResponse,
  SetThreadLabelRequest,
  ThreadLabelsResponse,
} from "@invook/contracts";
import axios from "axios";

export async function createMailLabel(input: CreateMailLabelRequest): Promise<MailLabel> {
  const response = await axios.post<MailLabelResponse>("/v1/labels", input);
  return response.data.label;
}

export async function deleteMailLabel(labelId: string): Promise<void> {
  await axios.delete<DeletedResourceResponse>(`/v1/labels/${labelId}`);
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
