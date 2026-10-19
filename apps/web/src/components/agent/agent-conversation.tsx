"use client";

import { useChat } from "@ai-sdk/react";
import { ArrowUp02Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AGENT_MESSAGE_MAX_LENGTH,
  type AgentApprovalDecision,
  type InvookAgentUIMessage,
} from "@invook/contracts";
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { v4 as uuidv4 } from "uuid";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  getAgentRetryRequest,
  type AgentSocketTransport,
} from "@/lib/agent/agent-socket-transport";

import { AgentMessage } from "./agent-message";

export interface AgentConversationProps {
  conversationId: string;
  initialMessages: InvookAgentUIMessage[];
  transport: AgentSocketTransport;
  accountSelection: string;
}

export function AgentConversation({
  conversationId,
  initialMessages,
  transport,
  accountSelection,
}: AgentConversationProps) {
  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    clearError,
    addToolApprovalResponse,
  } = useChat<InvookAgentUIMessage>({
    id: conversationId,
    messages: initialMessages,
    transport,
    // The server stores messages under UUID keys, including the user's own.
    generateId: uuidv4,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const isWorking = status === "submitted" || status === "streaming";
  const retryRequest = isWorking ? null : getAgentRetryRequest(messages);
  const lastMessage = messages.at(-1);
  const lastMessageId = lastMessage?.id;
  // Metadata starts the SDK's streaming state before there is visible content.
  const isWaitingForResponse = status === "submitted" ||
    lastMessage?.role !== "assistant" ||
    !lastMessage.parts.some((part) =>
      (part.type === "text" && part.text.length > 0) || isToolUIPart(part),
    );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  function submitDraft(): void {
    const text = draft.trim();
    if (!text || isWorking) return;
    setDraft("");
    clearError();
    void sendMessage({ text });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    submitDraft();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    submitDraft();
  }

  function handleRetry(): void {
    if (!retryRequest) return;
    clearError();
    void (retryRequest.type === "resubmit"
      ? sendMessage()
      : sendMessage({ text: retryRequest.text }));
  }

  function handleDecide(decision: AgentApprovalDecision): void {
    clearError();
    void addToolApprovalResponse({
      id: decision.approvalId,
      approved: decision.approved,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-center px-2 text-center">
            <p className="text-sm font-medium">Ask the agent</p>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              It can reply to the open email, write new email, and search your
              mail and attachment filenames. Nothing is sent without your
              approval.
            </p>
          </div>
        ) : (
          <div className="space-y-5" aria-live="polite">
            {messages.map((message) => (
              <AgentMessage
                key={message.id}
                message={message}
                accountSelection={accountSelection}
                canDecide={!isWorking}
                onDecide={handleDecide}
                canRetry={retryRequest !== null && message.id === lastMessageId}
                onRetry={handleRetry}
              />
            ))}
            {isWorking ? (
              <p className="text-xs text-muted-foreground" role="status">
                {isWaitingForResponse ? "Working…" : "Responding…"}
              </p>
            ) : null}
          </div>
        )}
        {error ? (
          <div role="alert" className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-destructive">{error.message}</p>
            {retryRequest ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0 rounded-md"
                onClick={handleRetry}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
      <form onSubmit={handleSubmit} className="px-3 pb-3">
        <div className="flex items-end gap-2 rounded-xl bg-background px-3 py-2">
          <Textarea
            aria-label="Message the agent"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply to this email, write a new one, or find mail…"
            maxLength={AGENT_MESSAGE_MAX_LENGTH}
            rows={1}
            className="max-h-40 min-h-8 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-[13px] leading-5 shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
          />
          {isWorking ? (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="rounded-lg"
              aria-label="Stop the agent"
              onClick={() => void stop()}
            >
              <HugeiconsIcon icon={StopIcon} size={15} />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              className="rounded-lg"
              aria-label="Send to the agent"
              disabled={!draft.trim()}
            >
              <HugeiconsIcon icon={ArrowUp02Icon} size={15} />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
