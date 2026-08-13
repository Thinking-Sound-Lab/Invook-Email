"use client";

import { useChat } from "@ai-sdk/react";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  BotIcon,
  Clock01Icon,
  Loading01Icon,
  PencilEdit01Icon,
  Search02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  IndexingProgress,
  MailboxActionProposal,
} from "@invook/contracts";
import { DefaultChatTransport, type UIDataTypes, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { formatMailText } from "./mail-format";
import { ActionProposalCard } from "./action-proposal-card";

type MailAgentUIMessage = UIMessage<
  never,
  UIDataTypes,
  {
    proposeMailboxAction: {
      input: unknown;
      output: MailboxActionProposal;
    };
  }
>;

interface IndexingStatusProps {
  progress: IndexingProgress;
}

function IndexingStatus({ progress }: IndexingStatusProps) {
  const { state } = progress;
  if (state === "complete") return null;

  const running = state === "running";
  const failed = state === "failed";
  const title = failed
    ? "Indexing paused"
    : running
      ? "Indexing your mail"
      : "Indexing pending";
  const detail = failed
    ? progress.totalMessageCount > 0
      ? `${progress.completedMessageCount.toLocaleString()} of ${progress.totalMessageCount.toLocaleString()} messages indexed${progress.failedMessageCount > 0 ? `; ${progress.failedMessageCount.toLocaleString()} failed` : ""}. Full-text search still works.`
      : "Indexing is unavailable until mailbox synchronization recovers."
    : running
      ? `${progress.completedMessageCount.toLocaleString()} of ${progress.totalMessageCount.toLocaleString()} messages indexed.`
      : progress.totalMessageCount > 0
        ? `${progress.totalMessageCount.toLocaleString()} messages are waiting to be indexed.`
        : "Semantic search is not ready yet.";
  const icon = failed ? Alert02Icon : running ? Loading01Icon : Clock01Icon;

  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "rounded-lg bg-primary/[0.07] px-3 py-2.5",
        failed && "bg-destructive/[0.08]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary",
            failed && "bg-destructive/10 text-destructive",
          )}
        >
          <span className={cn("grid", running && "motion-safe:animate-spin")}>
            <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} />
          </span>
        </span>
        <div className="min-w-0 pt-0.5">
          <p className="text-xs font-semibold text-foreground/88">{title}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {detail}
          </p>
        </div>
      </div>
    </div>
  );
}

export interface AgentPanelProps {
  openThreadId?: string;
  openThreadSubject?: string;
  aiConfigured: boolean;
  indexingProgress: IndexingProgress;
}

export function AgentPanel({
  openThreadId,
  openThreadSubject,
  aiConfigured,
  indexingProgress,
}: AgentPanelProps) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/v1/agent",
        body: openThreadId ? { currentThreadId: openThreadId } : {},
      }),
    [openThreadId],
  );
  const {
    messages,
    sendMessage,
    status,
    error,
    setMessages,
  } = useChat<MailAgentUIMessage>({ transport });
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const suggestions = openThreadId
    ? [
        { label: "Summarize this thread", icon: BotIcon },
        { label: "Draft a reply to this thread", icon: PencilEdit01Icon },
        { label: "Find a related message", icon: Search02Icon },
      ]
    : [
        { label: "Find my resident certificate", icon: Search02Icon },
        { label: "Find a message or decision", icon: Search02Icon },
        { label: "Help me draft a follow-up", icon: PencilEdit01Icon },
      ];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  const handleSubmit = (text: string) => {
    const value = text.trim();
    if (!value || !aiConfigured || busy) return;
    void sendMessage({ text: value });
    setInput("");
  };

  return (
    <aside
      className="hidden min-h-0 flex-col bg-card xl:flex"
      aria-label="Invook agent"
    >
      <header className="flex h-15 shrink-0 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <HugeiconsIcon
            icon={BotIcon}
            size={16}
            strokeWidth={1.7}
            className="shrink-0 text-muted-foreground"
          />
          <h2 className="truncate text-[15px] font-semibold">Invook</h2>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          disabled={messages.length === 0 || busy}
          onClick={() => setMessages([])}
          aria-label="Start a new chat"
          className="text-muted-foreground"
        >
          <HugeiconsIcon icon={PencilEdit01Icon} size={15} />
        </Button>
      </header>

      <div className="mx-3 space-y-2">
        <IndexingStatus progress={indexingProgress} />
        {openThreadSubject ? (
          <div className="rounded-lg bg-background/45 px-3 py-2.5">
            <p className="text-xs font-medium text-muted-foreground">Current thread</p>
            <p className="mt-1 truncate text-[13px] text-foreground/82">
              {formatMailText(openThreadSubject)}
            </p>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end pb-2">
            <div className="space-y-1">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  disabled={!aiConfigured || busy}
                  onClick={() => handleSubmit(suggestion.label)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-[13px] text-foreground/76 transition-colors hover:bg-accent disabled:opacity-45"
                >
                  <HugeiconsIcon
                    icon={suggestion.icon}
                    size={14}
                    strokeWidth={1.65}
                    className="text-muted-foreground"
                  />
                  <span>{suggestion.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "text-[13px] leading-5",
                  message.role === "user"
                    ? "ml-8 rounded-xl bg-primary px-3 py-2 text-primary-foreground"
                    : "mr-2 text-foreground/82",
                )}
              >
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <p key={index} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    );
                  }
                  if (
                    part.type === "tool-proposeMailboxAction" &&
                    part.state === "output-available"
                  ) {
                    return (
                      <ActionProposalCard
                        key={part.toolCallId}
                        initialProposal={part.output}
                      />
                    );
                  }
                  if (part.type.startsWith("tool-")) {
                    return (
                      <div
                        key={index}
                        className="my-1.5 flex items-center gap-2 rounded-md bg-secondary/55 px-2.5 py-2 text-xs text-muted-foreground"
                      >
                        <HugeiconsIcon icon={SparklesIcon} size={12} />
                        Working with mailbox data
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            ))}
            {busy ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <HugeiconsIcon icon={SparklesIcon} size={12} />
                {status === "submitted" ? "Thinking" : "Working"}
              </div>
            ) : null}
            {error ? (
              <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                Invook could not complete that request.
              </p>
            ) : null}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <form
        className="shrink-0 p-3 pt-0"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit(input);
        }}
      >
        <div className="rounded-xl bg-background/72 p-2 shadow-xl shadow-black/15">
          <Textarea
            disabled={!aiConfigured || busy}
            aria-label="Message Invook agent"
            placeholder={
              aiConfigured
                ? "Ask Invook to find or draft mail"
                : "Connect an AI model to chat"
            }
            className="min-h-20 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex justify-end pt-1">
            <Button
              size="icon-sm"
              type="submit"
              disabled={!input.trim() || !aiConfigured || busy}
              aria-label="Send message"
              className="rounded-full"
            >
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} />
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
