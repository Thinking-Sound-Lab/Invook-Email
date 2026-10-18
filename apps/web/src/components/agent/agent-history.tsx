"use client";

import type { AgentConversationSummary } from "@invook/contracts";
import axios from "axios";
import { useEffect, useState } from "react";

import { LocalMailDate } from "@/components/mail/local-mail-date";
import { listAgentConversations } from "@/lib/api/agent";

type HistoryState =
  | { loadState: "loading" }
  | { loadState: "error" }
  | { loadState: "available"; conversations: AgentConversationSummary[] };

export interface AgentHistoryProps {
  onSelect: (conversationId: string) => void;
}

export function AgentHistory({ onSelect }: AgentHistoryProps) {
  const [state, setState] = useState<HistoryState>({ loadState: "loading" });

  useEffect(() => {
    const requestController = new AbortController();
    void (async () => {
      try {
        const { conversations } = await listAgentConversations(
          requestController.signal,
        );
        if (requestController.signal.aborted) return;
        setState({ loadState: "available", conversations });
      } catch (cause: unknown) {
        if (axios.isCancel(cause) || requestController.signal.aborted) return;
        setState({ loadState: "error" });
      }
    })();
    return () => requestController.abort();
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <p className="px-2 pb-2 text-xs font-medium text-muted-foreground">
        Recent conversations
      </p>
      {state.loadState === "loading" ? (
        <p className="px-2 text-xs text-muted-foreground" role="status">
          Loading conversations…
        </p>
      ) : null}
      {state.loadState === "error" ? (
        <p className="px-2 text-xs text-destructive" role="alert">
          Conversations are unavailable right now.
        </p>
      ) : null}
      {state.loadState === "available" && state.conversations.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          No saved conversations yet.
        </p>
      ) : null}
      {state.loadState === "available" && state.conversations.length > 0 ? (
        <ul className="space-y-0.5" aria-label="Saved conversations">
          {state.conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                onClick={() => onSelect(conversation.id)}
                className="flex w-full items-baseline justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                <span className="min-w-0 truncate text-[13px]">
                  {conversation.title}
                </span>
                <LocalMailDate
                  className="shrink-0 text-[11px] text-muted-foreground"
                  value={conversation.updatedAt}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
