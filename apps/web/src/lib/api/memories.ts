import type {
  DeletedResourceResponse,
  MemoryEntry,
  MemoryEntryResponse,
  SaveMemoryRequest,
} from "@invook/contracts";
import axios from "axios";

export interface SaveMemoryInput extends SaveMemoryRequest {
  memoryId?: string;
}

export async function saveMemory({
  memoryId,
  type,
  contactEmail,
  statement,
}: SaveMemoryInput): Promise<MemoryEntry> {
  const request: SaveMemoryRequest = { type, contactEmail, statement };
  const response = memoryId
    ? await axios.patch<MemoryEntryResponse>(`/v1/memories/${memoryId}`, request)
    : await axios.post<MemoryEntryResponse>("/v1/memories", request);
  return response.data.memory;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  await axios.delete<DeletedResourceResponse>(`/v1/memories/${memoryId}`);
}
