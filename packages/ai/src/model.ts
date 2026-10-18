import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

export class AiConfigurationError extends Error {
  constructor() {
    super("OPENAI_API_KEY is required for Invook AI features.");
    this.name = "AiConfigurationError";
  }
}

/**
 * Live per-thread classification and the historical label Batch classify
 * against the same model, so one default serves both while each keeps its own
 * environment override.
 */
export const DEFAULT_LABEL_MODEL = "gpt-5.6-luna";

export type OpenAiCredentials = {
  apiKey: string;
  baseURL?: string;
};

/**
 * One OpenAI endpoint serves both live and Batch analysis, so the shared
 * credential and its optional base URL are read only here.
 */
export function readOpenAiCredentials(): OpenAiCredentials | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  return { apiKey, ...(baseURL ? { baseURL } : {}) };
}

export function getAiModel() {
  const credentials = readOpenAiCredentials();
  if (!credentials) throw new AiConfigurationError();

  const modelId = process.env.OPENAI_MODEL?.trim() || DEFAULT_LABEL_MODEL;
  return { model: createOpenAI(credentials).chat(modelId), modelId };
}

/**
 * The mail agent keeps its own override because drafting and tool use may
 * warrant a larger model than labeling. Without one it uses the model this
 * installation already runs, rather than assuming another model is available.
 *
 * OpenAI accepts function tools on its reasoning models only through the
 * Responses API. Responses are not stored at OpenAI: Invook keeps the agent's
 * history itself, so mailbox content is not retained there as conversation
 * state, and every request carries its full history.
 */
export function getAgentModel() {
  const credentials = readOpenAiCredentials();
  if (!credentials) throw new AiConfigurationError();
  const modelId = process.env.OPENAI_AGENT_MODEL?.trim() || DEFAULT_LABEL_MODEL;
  return {
    model: wrapLanguageModel({
      model: createOpenAI(credentials).responses(modelId),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { openai: { store: false } } },
      }),
    }),
    modelId,
  };
}

export function isAiConfigured(): boolean {
  return readOpenAiCredentials() !== null;
}
