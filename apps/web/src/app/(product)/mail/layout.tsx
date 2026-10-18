import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AgentPane } from "@/components/agent/agent-pane";
import { AccountPipelineStripe } from "@/components/mail/account-pipeline-stripe";
import { MailboxEventSubscriber } from "@/components/mail/mailbox-event-subscriber";
import { MailShellProvider } from "@/components/mail/mail-shell-provider";
import { MailSidebar } from "@/components/mail/mail-sidebar";
import { getMailboxShell, getMailboxSidebarCounts } from "@/lib/api";
import { SIGN_IN_PATH } from "@/lib/app-routes";

interface MailLayoutProps {
  children: ReactNode;
}

export default async function MailLayout({ children }: MailLayoutProps) {
  const [shell, sidebarCounts] = await Promise.all([
    getMailboxShell(),
    getMailboxSidebarCounts().catch(() => null),
  ]);
  if (!shell) redirect(SIGN_IN_PATH);

  return (
    <MailShellProvider shell={shell}>
      <main className="flex h-dvh flex-col overflow-hidden bg-background">
        <MailboxEventSubscriber />
        {/* The agent pane sizes the last track; it is empty while the pane is closed. */}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[64px_minmax(0,1fr)_auto] lg:grid-cols-[240px_minmax(0,1fr)_auto]">
          <MailSidebar sidebarCounts={sidebarCounts} />
          {children}
          <AgentPane />
        </div>
        <AccountPipelineStripe />
      </main>
    </MailShellProvider>
  );
}
