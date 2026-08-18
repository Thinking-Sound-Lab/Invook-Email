import { GoogleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AccountPipelineStripe } from "@/components/mail/account-pipeline-stripe";
import { MailboxEventSubscriber } from "@/components/mail/mailbox-event-subscriber";
import { MailShellProvider } from "@/components/mail/mail-shell-provider";
import { MailSidebar } from "@/components/mail/mail-sidebar";
import { Button } from "@/components/ui/button";
import { getMailboxShell, getMailboxSidebarCounts } from "@/lib/api";

interface MailLayoutProps {
  children: ReactNode;
}

export default async function MailLayout({ children }: MailLayoutProps) {
  const [shell, sidebarCounts] = await Promise.all([
    getMailboxShell(),
    getMailboxSidebarCounts().catch(() => null),
  ]);
  if (!shell) redirect("/");
  if (shell.account.status === "reconnect_required") {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6">
        <div className="flex w-full max-w-sm flex-col items-center text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">Reconnect Gmail</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Google no longer accepts the stored Gmail credential. Your local
            mailbox remains preserved and synchronization will resume only
            after Google authorization succeeds.
          </p>
          <form action="/v1/connections/gmail/start" method="get" className="mt-7 w-full">
            <input type="hidden" name="accountId" value={shell.account.id} />
            <Button type="submit" size="lg" className="h-11 w-full gap-2.5">
              <HugeiconsIcon icon={GoogleIcon} size={18} strokeWidth={1.7} />
              Reconnect Gmail
            </Button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <MailShellProvider shell={shell}>
      <main className="flex h-dvh flex-col overflow-hidden bg-background">
        <MailboxEventSubscriber />
        <div className="grid min-h-0 flex-1 grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(520px,1fr)_360px]">
          <MailSidebar sidebarCounts={sidebarCounts} />
          {children}
        </div>
        <AccountPipelineStripe accountEmail={shell.account.email} />
      </main>
    </MailShellProvider>
  );
}
