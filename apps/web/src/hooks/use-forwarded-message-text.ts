import axios from "axios";
import { useCallback, useEffect, useState } from "react";

import { getForwardedMessageText } from "@/lib/api/agent";

export type ForwardedMessageText =
  | { loadState: "none" }
  | { loadState: "loading" }
  | { loadState: "available"; text: string }
  | { loadState: "error" };

export interface UseForwardedMessageTextProps {
  accountId: string;
  messageId: string | null;
}

export interface UseForwardedMessageTextResult {
  forwarded: ForwardedMessageText;
  /** Reads the message again, such as after a failed read. */
  reload: () => void;
}

type LoadedText = { messageId: string; attempt: number } & (
  | { loadState: "available"; text: string }
  | { loadState: "error" }
);

/**
 * Loads the text a forward appends, exactly as the server will send it, so
 * an email is never approved without showing the message it forwards.
 */
export function useForwardedMessageText({
  accountId,
  messageId,
}: UseForwardedMessageTextProps): UseForwardedMessageTextResult {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<LoadedText | null>(null);

  useEffect(() => {
    if (!messageId) return;
    const requestController = new AbortController();
    void (async () => {
      try {
        const text = await getForwardedMessageText(
          { accountId, messageId },
          requestController.signal,
        );
        if (requestController.signal.aborted) return;
        setLoaded({ messageId, attempt, loadState: "available", text });
      } catch (cause: unknown) {
        if (axios.isCancel(cause) || requestController.signal.aborted) return;
        setLoaded({ messageId, attempt, loadState: "error" });
      }
    })();
    return () => requestController.abort();
  }, [accountId, messageId, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  if (!messageId) return { forwarded: { loadState: "none" }, reload };
  if (!loaded || loaded.messageId !== messageId || loaded.attempt !== attempt) {
    return { forwarded: { loadState: "loading" }, reload };
  }
  return {
    forwarded:
      loaded.loadState === "available"
        ? { loadState: "available", text: loaded.text }
        : { loadState: "error" },
    reload,
  };
}
