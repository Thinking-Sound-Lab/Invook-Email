"use client";

import { AlertCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTransition } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface ErrorPageProps {
  retry: () => void;
}

export default function ErrorPage({ retry }: ErrorPageProps) {
  const [isRetryPending, startRetryTransition] = useTransition();

  function handleRetry(): void {
    startRetryTransition(retry);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-5">
      <div className="w-full max-w-md space-y-4">
        <Alert variant="destructive">
          <HugeiconsIcon icon={AlertCircleIcon} size={17} />
          <AlertTitle>The workspace could not be loaded</AlertTitle>
          <AlertDescription>Your Gmail data was not changed.</AlertDescription>
        </Alert>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          aria-busy={isRetryPending}
          disabled={isRetryPending}
          onClick={handleRetry}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={16}
            className={isRetryPending ? "motion-safe:animate-spin" : undefined}
          />
          {isRetryPending ? "Reloading…" : "Try again"}
        </Button>
      </div>
    </main>
  );
}
