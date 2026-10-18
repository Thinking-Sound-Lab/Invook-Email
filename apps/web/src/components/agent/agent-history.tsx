"use client";

import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentConversationSummary } from "@invook/contracts";
import axios from "axios";
import { useEffect, useState } from "react";

import { LocalMailDate } from "@/components/mail/local-mail-date";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  deleteAgentConversation,
  listAgentConversations,
} from "@/lib/api/agent";
import { apiErrorMessage } from "@/lib/http-error";

type HistoryState =
  | { loadState: "loading" }
  | { loadState: "error" }
  | { loadState: "available"; conversations: AgentConversationSummary[] };

export interface AgentHistoryProps {
  onSelect: (conversationId: string) => void;
  onDeleted: (conversationId: string) => void;
}

export function AgentHistory({ onSelect, onDeleted }: AgentHistoryProps) {
  const [state, setState] = useState<HistoryState>({ loadState: "loading" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(conversationId: string): Promise<void> {
    setDeletingId(conversationId);
    setDeleteError(null);
    try {
      await deleteAgentConversation(conversationId);
      setState((current) =>
        current.loadState === "available"
          ? {
              loadState: "available",
              conversations: current.conversations.filter(
                (conversation) => conversation.id !== conversationId,
              ),
            }
          : current,
      );
      onDeleted(conversationId);
    } catch (error: unknown) {
      setDeleteError(apiErrorMessage(error, "That conversation could not be deleted."));
    } finally {
      setDeletingId(null);
    }
  }

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
      {deleteError ? (
        <p className="px-2 pb-2 text-xs text-destructive" role="alert">
          {deleteError}
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
            <li key={conversation.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(conversation.id)}
                className="flex min-w-0 flex-1 items-baseline justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                <span className="min-w-0 truncate text-[13px]">
                  {conversation.title}
                </span>
                <LocalMailDate
                  className="shrink-0 text-[11px] text-muted-foreground"
                  value={conversation.updatedAt}
                />
              </button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 rounded-md text-muted-foreground"
                    aria-label={`Delete ${conversation.title}`}
                    disabled={deletingId === conversation.id}
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={14} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Invook deletes the conversation and the email text it
                      copied while answering. Drafts and sent mail stay in Gmail.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="border-0">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => void handleDelete(conversation.id)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
