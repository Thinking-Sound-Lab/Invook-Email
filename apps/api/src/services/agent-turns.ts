import {
  convertToModelMessages,
  safeValidateUIMessages,
  streamText,
  toUIMessageStream,
  type LanguageModel,
} from "ai";
import { v4 as uuidv4 } from "uuid";

import {
  createMailAgentSettings,
  createMailAgentTools,
  getAgentModel,
  type MailAgentCapabilities,
  type MailAgentContext,
} from "@invook/ai";
import type {
  AgentClientFrame,
  AgentServerFrame,
  AgentTurnRejection,
  InvookAgentUIMessage,
} from "@invook/contracts";
import {
  AgentMessageConflictError,
  finishAgentRun,
  getAgentSessionIdentity,
  getMailboxShellData,
  renewAgentRun,
  saveAgentRunMessages,
  startAgentRun,
  type StoredAgentMessage,
} from "@invook/database";

import { applyAgentApprovalDecisions } from "./agent-approvals";
import { createAgentCapabilities } from "./agent-capabilities";

const TITLE_LIMIT = 80;
const RESPONSE_FAILURE_TEXT = "The agent could not finish this response.";

export type AgentTurnFrame = Extract<
  AgentClientFrame,
  { type: "message" | "approval" }
>;

export interface AgentTurnInput {
  userId: string;
  sessionId: string;
  frame: AgentTurnFrame;
  abortSignal: AbortSignal;
  send: (frame: AgentServerFrame) => void;
}

export type AgentTurnResult = { isSessionEnded: boolean };

export interface AgentTurnDependencies {
  getIdentity: typeof getAgentSessionIdentity;
  listAccounts: (userId: string) => Promise<MailAgentContext["accounts"]>;
  startRun: typeof startAgentRun;
  saveRunMessages: typeof saveAgentRunMessages;
  renewRun: typeof renewAgentRun;
  finishRun: typeof finishAgentRun;
  createCapabilities: (scope: {
    userId: string;
    conversationId: string;
  }) => MailAgentCapabilities;
  getModel: () => { model: LanguageModel };
  generateId: () => string;
  now: () => Date;
}

async function listAgentAccounts(
  userId: string,
): Promise<MailAgentContext["accounts"]> {
  const shell = await getMailboxShellData(userId);
  return (shell?.accounts ?? []).flatMap((account) =>
    account.status === "disconnected"
      ? []
      : [{ id: account.id, email: account.email, status: account.status }],
  );
}

const defaultDependencies: AgentTurnDependencies = {
  getIdentity: getAgentSessionIdentity,
  listAccounts: listAgentAccounts,
  startRun: startAgentRun,
  saveRunMessages: saveAgentRunMessages,
  renewRun: renewAgentRun,
  finishRun: finishAgentRun,
  createCapabilities: createAgentCapabilities,
  getModel: getAgentModel,
  generateId: uuidv4,
  now: () => new Date(),
};

export function getConversationTitle(text: string): string {
  const title = text.replace(/\s+/g, " ").trim();
  return title.length <= TITLE_LIMIT
    ? title
    : `${title.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

function toStoredMessage(
  message: InvookAgentUIMessage,
): StoredAgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (message.parts.length === 0) return null;
  return { id: message.id, role: message.role, parts: message.parts };
}

function logTurnFailure(conversationId: string, stage: string, error: unknown) {
  console.error("api: agent turn failed", {
    conversationId,
    stage,
    name: error instanceof Error ? error.name : "UnknownError",
  });
}

/**
 * Runs one agent turn against server-held history. The client contributes a
 * new user message or approval decisions; everything else, including which
 * email is open, is re-read under the signed-in user's scope.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  dependencies: AgentTurnDependencies = defaultDependencies,
): Promise<AgentTurnResult> {
  const { frame } = input;
  const { conversationId } = frame;
  const reject = (reason: AgentTurnRejection) =>
    input.send({ type: "rejected", conversationId, reason });

  const identity = await dependencies.getIdentity({
    userId: input.userId,
    sessionId: input.sessionId,
  });
  if (!identity) {
    reject("session_ended");
    return { isSessionEnded: true };
  }

  const runId = dependencies.generateId();
  let start: Awaited<ReturnType<typeof startAgentRun>>;
  try {
    start = await dependencies.startRun({
      userId: input.userId,
      conversationId,
      runId,
      newMessage:
        frame.type === "message"
          ? {
              title: getConversationTitle(frame.text),
              message: {
                id: frame.messageId,
                role: "user",
                parts: [{ type: "text", text: frame.text }],
              },
            }
          : null,
    });
  } catch (error) {
    if (!(error instanceof AgentMessageConflictError)) throw error;
    reject("invalid");
    return { isSessionEnded: false };
  }
  if (start.outcome !== "started") {
    reject(start.outcome);
    return { isSessionEnded: false };
  }

  let isRunFinished = false;
  let hasStreamed = false;
  try {
    const capabilities = dependencies.createCapabilities({
      userId: input.userId,
      conversationId,
    });
    const validation = await safeValidateUIMessages<InvookAgentUIMessage>({
      messages: start.messages,
      tools: createMailAgentTools(capabilities),
    });
    if (!validation.success) {
      logTurnFailure(conversationId, "history", validation.error);
      reject("unavailable");
      return { isSessionEnded: false };
    }
    let messages = validation.data;
    if (frame.type === "approval") {
      const decided = applyAgentApprovalDecisions(messages, frame.decisions);
      const stored = decided ? toStoredMessage(decided) : null;
      if (!decided || !stored) {
        reject("invalid");
        return { isSessionEnded: false };
      }
      const { saved } = await dependencies.saveRunMessages({
        userId: input.userId,
        conversationId,
        runId,
        messages: [stored],
        finishRun: false,
      });
      if (!saved) {
        reject("busy");
        return { isSessionEnded: false };
      }
      messages = [...messages.slice(0, -1), decided];
    }

    const accounts = await dependencies.listAccounts(input.userId);
    const selection = frame.focus.accountSelection;
    const selectedAccountId =
      accounts.find((account) => account.id === selection)?.id ??
      (accounts.length === 1 ? (accounts[0]?.id ?? null) : null);
    const openThread = frame.focus.threadId
      ? await capabilities.readThread({ threadId: frame.focus.threadId })
      : null;
    const settings = createMailAgentSettings({
      capabilities,
      context: {
        user: identity,
        accounts,
        selectedAccountId,
        openThread: openThread?.status === "available" ? openThread.thread : null,
        now: dependencies.now(),
      },
    });
    const result = streamText({
      model: dependencies.getModel().model,
      ...settings,
      messages: await convertToModelMessages(messages, { tools: settings.tools }),
      abortSignal: input.abortSignal,
      // Replaces the SDK default, which prints the provider request body and
      // with it the mailbox content in the prompt.
      onError: ({ error }) => logTurnFailure(conversationId, "model", error),
      onStepEnd: async () => {
        await dependencies.renewRun({ conversationId, runId });
      },
    });
    const reader = toUIMessageStream({
      stream: result.stream,
      tools: settings.tools,
      originalMessages: messages,
      generateMessageId: dependencies.generateId,
      sendReasoning: false,
      onError: (error) => {
        logTurnFailure(conversationId, "stream", error);
        return RESPONSE_FAILURE_TEXT;
      },
      // Awaited before the stream closes, so history is stored before the
      // client hears that the turn ended.
      onEnd: async ({ responseMessage }) => {
        const stored = toStoredMessage(responseMessage);
        if (!stored) return;
        const { saved } = await dependencies.saveRunMessages({
          userId: input.userId,
          conversationId,
          runId,
          messages: [stored],
          finishRun: true,
        });
        isRunFinished = saved;
        if (!saved) logTurnFailure(conversationId, "lease", new Error("Lease lost"));
      },
    }).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasStreamed = true;
      input.send({ type: "chunk", conversationId, chunk: value });
    }
    input.send({ type: "end", conversationId });
  } catch (error) {
    logTurnFailure(conversationId, "run", error);
    if (hasStreamed) {
      input.send({
        type: "chunk",
        conversationId,
        chunk: { type: "error", errorText: RESPONSE_FAILURE_TEXT },
      });
      input.send({ type: "end", conversationId });
    } else {
      reject("unavailable");
    }
  } finally {
    if (!isRunFinished) {
      await dependencies.finishRun({ conversationId, runId });
    }
  }
  return { isSessionEnded: false };
}
