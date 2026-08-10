import {
  embedMailboxTexts,
  getEmbeddingConfiguration,
  isEmbeddingConfigured,
} from "@invook/ai";
import { MAIL_INDEX_VERSION, searchMailbox } from "@invook/database";

export async function searchMailForUser(input: {
  userId: string;
  query: string;
  onSemanticError?: (error: unknown) => void;
}) {
  let embedding:
    | {
        values: number[];
        modelId: string;
        dimensions: number;
        indexVersion: number;
      }
    | undefined;
  if (isEmbeddingConfigured()) {
    try {
      const config = getEmbeddingConfiguration();
      const result = await embedMailboxTexts([input.query]);
      embedding = {
        values: result.embeddings[0]!,
        modelId: config.modelId,
        dimensions: config.dimensions,
        indexVersion: MAIL_INDEX_VERSION,
      };
    } catch (error) {
      input.onSemanticError?.(error);
    }
  }
  const results = await searchMailbox({
    userId: input.userId,
    query: input.query,
    embedding,
  });
  return results.map((result) => ({
    ...result,
    sentAt: result.sentAt.toISOString(),
  }));
}
