"use client";

import {
  AiChat02Icon,
  Cancel01Icon,
  Clock01Icon,
  Mail01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { validate as validateUuid } from "uuid";

import { resolveMailboxAccountSelection } from "@/components/mail/mail-account-scope";
import { formatMailText } from "@/components/mail/mail-format";
import { useMailShell } from "@/components/mail/mail-shell-provider";
import { Button } from "@/components/ui/button";
import { useAgentConversationSelection } from "@/hooks/use-agent-conversation-selection";
import {
  AgentSocketConnection,
  AgentSocketTransport,
} from "@/lib/agent/agent-socket-transport";
import { createAgentSocketTicket } from "@/lib/api/agent";
import { cn } from "@/lib/utils";
import { useAgentPaneStore } from "@/stores/agent/store";
import { useMailboxStore } from "@/stores/mailbox/store";

import { AgentConversation } from "./agent-conversation";
import { AgentHistory } from "./agent-history";

export function AgentPane() {
  const isPaneOpen = useAgentPaneStore((state) => state.isPaneOpen);
  return isPaneOpen ? <AgentPaneContent /> : null;
}

function AgentPaneContent() {
  const setPaneOpen = useAgentPaneStore((state) => state.setPaneOpen);
  const searchParams = useSearchParams();
  const { accounts } = useMailShell();
  const accountSelection = resolveMailboxAccountSelection(
    searchParams.get("account"),
    accounts,
  );
  const requestedThreadId = searchParams.get("thread");
  const threadId =
    requestedThreadId && validateUuid(requestedThreadId) ? requestedThreadId : null;
  const openSubject = useMailboxStore((state) =>
    threadId
      ? (state.detailsById[threadId]?.thread.subject ??
        state.threadsById[threadId]?.subject ??
        null)
      : null,
  );

  const [connection] = useState(
    () =>
      new AgentSocketConnection({
        createTicket: createAgentSocketTicket,
        createSocket: (url, protocols) => new WebSocket(url, protocols),
      }),
  );
  const [transport] = useState(
    () => new AgentSocketTransport(connection, { accountSelection, threadId }),
  );
  // Each request carries what is open at the moment the user sends it.
  useEffect(() => {
    transport.setFocus({ accountSelection, threadId });
  }, [transport, accountSelection, threadId]);
  useEffect(() => {
    connection.activate();
    return () => connection.deactivate();
  }, [connection]);

  // The open conversation stays mounted under the history list, so browsing
  // history never interrupts a running turn.
  const {
    conversation,
    loadingConversationId,
    openError,
    openConversation,
    startNewConversation,
    markConversationDeleted,
    clearOpenError,
  } = useAgentConversationSelection();
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  async function handleOpenConversation(conversationId: string): Promise<void> {
    if (await openConversation(conversationId)) setIsHistoryOpen(false);
  }

  function handleNewConversation(): void {
    startNewConversation();
    setIsHistoryOpen(false);
  }

  function handleToggleHistory(): void {
    clearOpenError();
    setIsHistoryOpen((isOpen) => !isOpen);
  }

  return (
    <aside
      aria-label="Agent"
      className="fixed inset-0 z-40 flex min-h-0 flex-col bg-sidebar lg:static lg:z-auto lg:w-[380px] xl:w-[420px]"
    >
      <header className="flex h-15 shrink-0 items-center justify-between gap-2 border-b border-border/45 px-3">
        <h2 className="flex items-center gap-2 px-1 text-[15px] font-semibold tracking-[-0.02em]">
          <HugeiconsIcon icon={AiChat02Icon} size={16} />
          Agent
        </h2>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-md"
            aria-label="Conversation history"
            aria-pressed={isHistoryOpen}
            onClick={handleToggleHistory}
          >
            <HugeiconsIcon icon={Clock01Icon} size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-md"
            aria-label="New conversation"
            onClick={handleNewConversation}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-md"
            aria-label="Close agent"
            onClick={() => setPaneOpen(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </Button>
        </div>
      </header>
      <p className="flex shrink-0 items-center gap-1.5 px-4 pt-3 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Mail01Icon} size={13} className="shrink-0" />
        <span className="truncate">
          {threadId
            ? `Open email: ${formatMailText(openSubject ?? "") || "(No subject)"}`
            : "No email open"}
        </span>
      </p>
      <div className={cn("flex min-h-0 flex-1 flex-col", isHistoryOpen && "hidden")}>
        <AgentConversation
          key={conversation.conversationId}
          conversationId={conversation.conversationId}
          initialMessages={conversation.initialMessages}
          transport={transport}
          accountSelection={accountSelection}
        />
      </div>
      {isHistoryOpen ? (
        <>
          {loadingConversationId ? (
            <p className="px-4 pt-3 text-xs text-muted-foreground" role="status">
              Opening conversation…
            </p>
          ) : null}
          {openError ? (
            <p role="alert" className="px-4 pt-3 text-xs text-destructive">
              {openError}
            </p>
          ) : null}
          <AgentHistory
            onSelect={(conversationId) => void handleOpenConversation(conversationId)}
            onDeleted={markConversationDeleted}
          />
        </>
      ) : null}
    </aside>
  );
}
