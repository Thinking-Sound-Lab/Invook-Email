import { redirect } from "next/navigation";
import { connection } from "next/server";

import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { Button } from "@/components/ui/button";
import { getSessionState } from "@/lib/api";

export default async function ConnectPage() {
  await connection();
  const session = await getSessionState();
  if (session.authenticated && session.gmailConnected) redirect("/mail");

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="flex w-full max-w-xs flex-col items-center gap-8">
        <h1 className="text-4xl font-semibold tracking-[-0.05em]">Invook</h1>

        {session.authenticated ? (
          <div className="w-full text-center">
            <p className="mb-5 text-sm leading-6 text-muted-foreground">
              You’re signed in to Invook. Connect a Gmail mailbox to continue.
            </p>
            <form action="/v1/connections/gmail/start" method="get">
              <Button type="submit" size="lg" className="h-11 w-full">
                Connect Gmail
              </Button>
            </form>
          </div>
        ) : (
          <GoogleSignInButton />
        )}
      </div>
    </main>
  );
}
