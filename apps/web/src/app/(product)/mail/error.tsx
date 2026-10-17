"use client";

import { Button } from "@/components/ui/button";

interface MailErrorProps {
  reset: () => void;
}

export default function MailError({ reset }: MailErrorProps) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="max-w-sm text-center" role="alert">
        <h1 className="text-xl font-semibold tracking-[-0.03em]">
          Mail is temporarily unavailable
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Invook could not read the current mailbox resource. No cached mailbox
          state has been substituted.
        </p>
        <Button type="button" className="mt-6" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
