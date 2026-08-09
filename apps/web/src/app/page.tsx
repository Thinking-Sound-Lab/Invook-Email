import { GoogleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { redirect } from "next/navigation";
import { connection } from "next/server";

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

        <form action="/v1/auth/google/start" method="get" className="w-full">
          <Button
            type="submit"
            size="lg"
            className="h-11 w-full gap-2.5"
          >
            <HugeiconsIcon icon={GoogleIcon} size={18} strokeWidth={1.7} />
            Sign in with Google
          </Button>
        </form>
      </div>
    </main>
  );
}
