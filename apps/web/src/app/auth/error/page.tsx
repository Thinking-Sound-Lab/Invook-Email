import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

type AuthenticationErrorPageProps = {
  searchParams: Promise<{ reason?: string }>;
};

const messages: Record<string, string> = {
  authorization: "Google sign-in could not be verified.",
  configuration: "Google sign-in is not configured for this installation.",
  gmail_access: "Google sign-in succeeded, but Gmail access was rejected.",
  offline_access: "Google did not grant the background access Invook needs.",
  unknown: "Invook could not finish connecting Gmail.",
};

export default async function AuthenticationErrorPage({
  searchParams,
}: AuthenticationErrorPageProps) {
  const { reason = "unknown" } = await searchParams;

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={28}
          strokeWidth={1.6}
          className="text-destructive"
        />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-[-0.04em]">Couldn’t connect Gmail</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {messages[reason] ?? messages.unknown}
          </p>
        </div>
        <Button asChild className="w-full">
          <Link href="/">Try again</Link>
        </Button>
      </div>
    </main>
  );
}
