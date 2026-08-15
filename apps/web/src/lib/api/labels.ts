import type {
  CreateInvookLabelRequest,
  CreateInvookLabelResponse,
  DeletedResourceResponse,
  InvookLabelPreviewResponse,
  InvookThreadLabel,
  PreviewInvookLabelRequest,
  SetThreadLabelRequest,
  ThreadLabelsResponse,
} from "@invook/contracts";
import axios from "axios";

export async function createInvookLabel(
  input: CreateInvookLabelRequest,
): Promise<CreateInvookLabelResponse> {
  const response = await axios.post<CreateInvookLabelResponse>(
    "/v1/labels",
    input,
  );
  return response.data;
}

export async function previewInvookLabel(
  input: PreviewInvookLabelRequest,
): Promise<InvookLabelPreviewResponse> {
  const response = await axios.post<InvookLabelPreviewResponse>(
    "/v1/labels/preview",
    input,
  );
  return response.data;
}

export async function deleteInvookLabel(labelId: string): Promise<void> {
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
