import type { InvookAgentUIMessage } from "@invook/contracts";
import { useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { getAgentConversation } from "@/lib/api/agent";
import { apiErrorMessage } from "@/lib/http-error";

export interface OpenAgentConversation {
  conversationId: string;
  initialMessages: InvookAgentUIMessage[];
}

export interface UseAgentConversationSelectionResult {
  conversation: OpenAgentConversation;
  loadingConversationId: string | null;
  openError: string | null;
  /** Loads a saved conversation; resolves whether it became the open one. */
  openConversation: (conversationId: string) => Promise<boolean>;
  startNewConversation: () => void;
  markConversationDeleted: (conversationId: string) => void;
  clearOpenError: () => void;
}

function createNewConversation(): OpenAgentConversation {
  return { conversationId: uuidv4(), initialMessages: [] };
}

/**
 * Owns which agent conversation is open. Only the most recent request may
 * open a conversation, so a slow read never replaces a newer choice or
 * reopens a conversation deleted while it loaded.
 */
export function useAgentConversationSelection(): UseAgentConversationSelectionResult {
  const [conversation, setConversation] = useState(createNewConversation);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const loadingConversationIdRef = useRef<string | null>(null);

  function stopLoading(): void {
    loadingConversationIdRef.current = null;
    setLoadingConversationId(null);
  }

  async function openConversation(conversationId: string): Promise<boolean> {
    loadingConversationIdRef.current = conversationId;
    setLoadingConversationId(conversationId);
    setOpenError(null);
    try {
      const { messages } = await getAgentConversation(conversationId);
      if (loadingConversationIdRef.current !== conversationId) return false;
      setConversation({ conversationId, initialMessages: messages });
      return true;
    } catch (error: unknown) {
      if (loadingConversationIdRef.current === conversationId) {
        setOpenError(apiErrorMessage(error, "That conversation could not be opened."));
      }
      return false;
    } finally {
      if (loadingConversationIdRef.current === conversationId) stopLoading();
    }
  }

  function startNewConversation(): void {
    stopLoading();
    setConversation(createNewConversation());
  }

  function markConversationDeleted(conversationId: string): void {
    if (loadingConversationIdRef.current === conversationId) stopLoading();
    // Reads the current conversation, since a deletion can finish after the
    // user has already opened another one.
    setConversation((current) =>
      current.conversationId === conversationId ? createNewConversation() : current,
    );
  }

  return {
    conversation,
    loadingConversationId,
    openError,
    openConversation,
    startNewConversation,
    markConversationDeleted,
    clearOpenError: () => setOpenError(null),
  };
}
