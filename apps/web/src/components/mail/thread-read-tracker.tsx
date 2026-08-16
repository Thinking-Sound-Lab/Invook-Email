"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { markGmailThreadRead } from "@/lib/api/gmail-thread-read-state";

import { submitThreadReadAttempt } from "./thread-read-state";

export interface ThreadReadTrackerProps {
  isUnread: boolean;
  threadId: string;
}

export function ThreadReadTracker({
  isUnread,
  threadId,
}: ThreadReadTrackerProps) {
  const attemptedThreadIdsRef = useRef(new Set<string>());
  const [hasFailed, setHasFailed] = useState(false);

  const submitReadState = useCallback(async (): Promise<void> => {
    if (!isUnread) return;
    const result = await submitThreadReadAttempt({
      attemptedThreadIds: attemptedThreadIdsRef.current,
      markRead: markGmailThreadRead,
      threadId,
    });
    if (result === "failed") setHasFailed(true);
  }, [isUnread, threadId]);

  useEffect(() => {
    void submitReadState();
  }, [submitReadState]);

  function handleRetry(): void {
    attemptedThreadIdsRef.current.delete(threadId);
    setHasFailed(false);
    void submitReadState();
  }

  if (!isUnread || !hasFailed) return null;

  return (
    <div
      role="alert"
      className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive sm:mx-10"
    >
      <p>Invook could not mark this thread as read.</p>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={handleRetry}
      >
        Retry
      </Button>
    </div>
  );
}
