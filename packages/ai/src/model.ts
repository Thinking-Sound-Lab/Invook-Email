import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export class AiConfigurationError extends Error {
  constructor() {
    super("AI_BASE_URL and AI_MODEL are required for mailbox analysis.");
    this.name = "AiConfigurationError";
  }
}

export function getAiModel() {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const modelId = process.env.AI_MODEL?.trim();
  if (!baseURL || !modelId) throw new AiConfigurationError();

  const apiKey = process.env.AI_API_KEY?.trim();
  const provider = createOpenAICompatible({
    name: "invook",
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    supportsStructuredOutputs: true,
  });

  return { model: provider.chatModel(modelId), modelId };
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.AI_BASE_URL?.trim() && process.env.AI_MODEL?.trim());
}
