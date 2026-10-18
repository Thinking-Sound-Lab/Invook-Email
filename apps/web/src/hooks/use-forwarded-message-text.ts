import axios from "axios";
import { useEffect, useState } from "react";

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

type LoadedText = { messageId: string } & (
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
}: UseForwardedMessageTextProps): ForwardedMessageText {
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
        setLoaded({ messageId, loadState: "available", text });
      } catch (cause: unknown) {
        if (axios.isCancel(cause) || requestController.signal.aborted) return;
        setLoaded({ messageId, loadState: "error" });
      }
    })();
    return () => requestController.abort();
  }, [accountId, messageId]);

  if (!messageId) return { loadState: "none" };
  if (!loaded || loaded.messageId !== messageId) return { loadState: "loading" };
  return loaded.loadState === "available"
    ? { loadState: "available", text: loaded.text }
    : { loadState: "error" };
}
