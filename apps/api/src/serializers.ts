import type { MemoryEntry, ReplyDraft } from "@invook/contracts";

export function serializeMemoryEntry(memory: {
  id: string;
  memoryType: MemoryEntry["type"];
  contactEmail: string | null;
  statement: string;
  source: MemoryEntry["source"];
  confidence: string | null;
  evidenceMessageIds: string[];
  evidenceDraftIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): MemoryEntry {
  return {
    id: memory.id,
    type: memory.memoryType,
    contactEmail: memory.contactEmail,
    statement: memory.statement,
    source: memory.source,
    confidence: memory.confidence === null ? null : Number(memory.confidence),
    evidenceMessageIds: memory.evidenceMessageIds,
    evidenceDraftIds: memory.evidenceDraftIds,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

export function serializeReplyDraft(draft: {
  id: string;
  threadId: string;
  status: ReplyDraft["status"];
  generatedText: string | null;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: Date;
}): ReplyDraft {
  if (!draft.generatedText) {
    throw new Error("A generated draft is missing its generated text.");
  }
  return {
    id: draft.id,
    threadId: draft.threadId,
    status: draft.status,
    generatedText: draft.generatedText,
    currentText: draft.currentText,
    usedMemoryIds: draft.usedMemoryIds,
    updatedAt: draft.updatedAt.toISOString(),
  };
}
