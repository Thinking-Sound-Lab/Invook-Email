import { GoogleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { validate as validateUuid } from "uuid";

import { mailboxViews } from "@invook/contracts";

import { AgentPanel } from "@/components/mail/agent-panel";
import { ComposeSurface } from "@/components/mail/compose-surface";
import { MailList } from "@/components/mail/mail-list";
import { MailboxEventSubscriber } from "@/components/mail/mailbox-event-subscriber";
import { MailSidebar } from "@/components/mail/mail-sidebar";
import { ThreadReader } from "@/components/mail/thread-reader";
import { Button } from "@/components/ui/button";
import type {
  MailboxView,
  MailSurface,
  MailThreadSummary,
  SelectedThread,
  StaticMailboxView,
} from "@/components/mail/types";
import {
  PendingSurface,
  SearchResultsSurface,
  SearchSurface,
} from "@/components/mail/workspace-surface";
import { getMailboxWorkspace, searchMailbox } from "@/lib/api";

interface MailPageProps {
  searchParams: Promise<{
    view?: string | string[];
    surface?: string | string[];
    thread?: string | string[];
    q?: string | string[];
    cursor?: string | string[];
  }>;
}

const mailboxViewSet = new Set<string>(mailboxViews);

const mailSurfaces = new Set<MailSurface>([
  "mail",
  "compose",
  "search",
  "automations",
]);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeView(value: string | undefined): MailboxView {
  if (value && mailboxViewSet.has(value)) return value as StaticMailboxView;
  if (value?.startsWith("label:")) {
    const labelId = value.slice("label:".length);
    if (validateUuid(labelId)) return `label:${labelId}`;
  }
  return "all";
}

function normalizeSurface(value: string | undefined): MailSurface {
  return value && mailSurfaces.has(value as MailSurface) ? (value as MailSurface) : "mail";
}

export default async function MailPage({ searchParams }: MailPageProps) {
  await connection();
  const params = await searchParams;

  const requestedThreadId = firstValue(params.thread);
  const requestedSurface = normalizeSurface(firstValue(params.surface));
  const currentSurface = requestedThreadId ? "mail" : requestedSurface;
  const query = firstValue(params.q)?.trim();
  const mailboxCursor = firstValue(params.cursor)?.trim() || undefined;
  const currentView = normalizeView(firstValue(params.view));

  const workspace = await getMailboxWorkspace({
    cursor: mailboxCursor,
    selectedThreadId: requestedThreadId,
    view: currentView,
  });
  if (!workspace) redirect("/");
  if (workspace.account.status === "reconnect_required") {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6">
        <div className="flex w-full max-w-sm flex-col items-center text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">
            Reconnect Gmail
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Google no longer accepts the stored Gmail credential. Your local
            mailbox remains preserved and synchronization will resume only
            after Google authorization succeeds.
          </p>
          <form
            action="/v1/connections/gmail/start"
            method="get"
            className="mt-7 w-full"
          >
            <input type="hidden" name="accountId" value={workspace.account.id} />
            <Button type="submit" size="lg" className="h-11 w-full gap-2.5">
              <HugeiconsIcon icon={GoogleIcon} size={18} strokeWidth={1.7} />
              Reconnect Gmail
            </Button>
          </form>
        </div>
      </main>
    );
  }
  const currentLabelId = currentView.startsWith("label:")
    ? currentView.slice("label:".length)
    : null;
  const currentLabel = currentLabelId
    ? [...workspace.gmailUserLabels, ...workspace.invookLabels].find(
        (label) => label.id === currentLabelId,
      )
    : null;

  const mailboxThreads = workspace.threads as MailThreadSummary[];
  const selectedThread = workspace.selectedThread as SelectedThread | null;
  const searchResults =
    currentSurface === "search" && query ? await searchMailbox(query) : [];

  let centerPane: React.ReactNode;
  if (selectedThread) {
    centerPane = (
      <ThreadReader
        thread={selectedThread}
        currentView={currentView}
        mailboxCursor={mailboxCursor}
        aiConfigured={workspace.aiConfigured}
        availableLabels={workspace.invookLabels}
      />
    );
  } else if (currentSurface === "compose") {
    centerPane = <ComposeSurface gmailAccountId={workspace.account.id} />;
  } else if (currentSurface === "search" && !query) {
    centerPane = <SearchSurface />;
  } else if (currentSurface === "search" && query) {
    centerPane = <SearchResultsSurface query={query} results={searchResults} />;
  } else if (currentSurface === "automations") {
    centerPane = <PendingSurface />;
  } else {
    centerPane = (
      <MailList
        account={workspace.account}
        currentView={currentView}
        title={currentLabel?.name}
        mailboxCursor={mailboxCursor}
        pagination={workspace.pagination}
        threads={mailboxThreads}
        query={currentSurface === "search" ? query : undefined}
      />
    );
  }

  return (
    <main className="h-dvh overflow-hidden bg-background">
      <MailboxEventSubscriber />
      <div className="grid h-full grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(520px,1fr)_360px]">
        <MailSidebar
          account={workspace.account}
          currentView={currentView}
          currentSurface={currentSurface}
          memories={workspace.memories}
          gmailUserLabels={workspace.gmailUserLabels}
          invookLabels={workspace.invookLabels}
          aiConfigured={workspace.aiConfigured}
          batchConfigured={workspace.batchConfigured}
        />
        <div
          data-slot="mail-workspace-content"
          className="min-h-0 min-w-0 overflow-hidden [&>*]:h-full"
        >
          {centerPane}
        </div>
        <AgentPanel
          key={selectedThread?.id ?? "mailbox"}
          openThreadId={selectedThread?.id}
          openThreadSubject={selectedThread?.subject || undefined}
          aiConfigured={workspace.aiConfigured}
        />
      </div>
    </main>
  );
}
