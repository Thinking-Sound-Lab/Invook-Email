import type {
  CreateGmailComposeDraftRequest,
  GmailComposeDraftResponse,
  GmailComposeSendResponse,
  SendGmailComposeDraftRequest,
  UpdateGmailComposeDraftRequest,
} from "@invook/contracts";
import axios from "axios";

export async function createGmailComposeDraft(
  request: CreateGmailComposeDraftRequest,
): Promise<GmailComposeDraftResponse> {
  const response = await axios.post<GmailComposeDraftResponse>(
    "/v1/gmail/compose-drafts",
    request,
  );
  return response.data;
}

export async function updateGmailComposeDraft(
  providerDraftId: string,
  request: UpdateGmailComposeDraftRequest,
): Promise<GmailComposeDraftResponse> {
  const response = await axios.put<GmailComposeDraftResponse>(
    `/v1/gmail/compose-drafts/${encodeURIComponent(providerDraftId)}`,
    request,
  );
  return response.data;
}

export async function sendGmailComposeDraft(
  providerDraftId: string,
  request: SendGmailComposeDraftRequest,
): Promise<GmailComposeSendResponse> {
  const response = await axios.post<GmailComposeSendResponse>(
    `/v1/gmail/compose-drafts/${encodeURIComponent(providerDraftId)}/send`,
    request,
  );
  return response.data;
}
