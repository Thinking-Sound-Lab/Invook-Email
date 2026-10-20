import { SIGN_IN_PATH } from "@invook/contracts";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AgentSettings } from "@/components/settings/agent-settings";
import { Button } from "@/components/ui/button";
import { getSessionState } from "@/lib/api";

/**
 * Agent settings outside the mailbox: a person can approve an agent before
 * connecting Gmail, and must be able to disconnect it without Gmail too.
 */
export default async function AgentSettingsPage() {
  await connection();
  const session = await getSessionState();
  if (!session.authenticated) redirect(SIGN_IN_PATH);

  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto w-full max-w-3xl py-8 sm:py-12">
        <div className="flex items-center justify-between px-5 sm:px-8">
          <p className="text-xl font-semibold tracking-[-0.04em]">Invook</p>
          <Button asChild variant="ghost" size="sm" className="text-xs text-muted-foreground">
            <Link href={session.gmailConnected ? "/mail" : SIGN_IN_PATH}>
              {session.gmailConnected ? "Back to mail" : "Connect Gmail"}
            </Link>
          </Button>
        </div>
        <AgentSettings />
      </div>
    </main>
  );
}
