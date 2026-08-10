import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AgentPanel } from "@/components/mail/agent-panel";
import { MailList } from "@/components/mail/mail-list";
import { MailSidebar } from "@/components/mail/mail-sidebar";
import { ThreadReader } from "@/components/mail/thread-reader";
import type {
  MailboxView,
  MailSurface,
  MailThreadSummary,
  SelectedThread,
} from "@/components/mail/types";
import {
  ComposeSurface,
  PendingSurface,
  SearchResultsSurface,
  SearchSurface,
  SettingsSurface,
} from "@/components/mail/workspace-surface";
import { getMailboxWorkspace, searchMailbox } from "@/lib/api";

type MailPageProps = {
  searchParams: Promise<{
    view?: string | string[];
    surface?: string | string[];
    thread?: string | string[];
    q?: string | string[];
  }>;
};

const mailboxViews = new Set<MailboxView>([
  "all",
  "travel",
  "important",
  "pitch",
  "newsletter",
  "starred",
  "shared",
  "reminders",
  "scheduled",
  "drafts",
  "done",
  "sent",
  "trash",
]);

const mailSurfaces = new Set<MailSurface>([
  "mail",
  "compose",
  "search",
  "settings",
  "automations",
]);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeView(value: string | undefined): MailboxView {
  return value && mailboxViews.has(value as MailboxView) ? (value as MailboxView) : "all";
}

function normalizeSurface(value: string | undefined): MailSurface {
  return value && mailSurfaces.has(value as MailSurface) ? (value as MailSurface) : "mail";
}

function hasLabel(thread: MailThreadSummary, ...labels: string[]): boolean {
  return labels.some((label) => thread.labelIds.includes(label));
}

function hasInvookLabel(
  thread: MailThreadSummary,
  label: "important" | "travel" | "pitch" | "newsletter",
): boolean {
  return thread.invookLabels.some((threadLabel) => threadLabel.key === label);
}

function filterByView(threads: MailThreadSummary[], view: MailboxView): MailThreadSummary[] {
  switch (view) {
    case "all":
      return threads;
    case "travel":
      return threads.filter((thread) => hasInvookLabel(thread, "travel"));
    case "important":
      return threads.filter((thread) => hasInvookLabel(thread, "important"));
    case "pitch":
      return threads.filter((thread) => hasInvookLabel(thread, "pitch"));
    case "newsletter":
      return threads.filter((thread) => hasInvookLabel(thread, "newsletter"));
    case "starred":
      return threads.filter((thread) => hasLabel(thread, "STARRED"));
    case "shared":
      return threads.filter((thread) => hasLabel(thread, "SHARED"));
    case "reminders":
      return threads.filter((thread) => hasLabel(thread, "REMINDER"));
    case "scheduled":
      return threads.filter((thread) => hasLabel(thread, "SCHEDULED"));
    case "drafts":
      return threads.filter((thread) => hasLabel(thread, "DRAFT"));
    case "done":
      return threads.filter((thread) => hasLabel(thread, "DONE"));
    case "sent":
      return threads.filter((thread) => hasLabel(thread, "SENT"));
    case "trash":
      return threads.filter((thread) => hasLabel(thread, "TRASH"));
  }
}

export default async function MailPage({ searchParams }: MailPageProps) {
  await connection();
  const params = await searchParams;

  const currentView = normalizeView(firstValue(params.view));
  const requestedThreadId = firstValue(params.thread);
  const requestedSurface = normalizeSurface(firstValue(params.surface));
  const currentSurface = requestedThreadId ? "mail" : requestedSurface;
  const query = firstValue(params.q)?.trim();

  const workspace = await getMailboxWorkspace(requestedThreadId);
  if (!workspace) redirect("/");

  const mailboxThreads = workspace.threads as MailThreadSummary[];
  const selectedThread = workspace.selectedThread as SelectedThread | null;
  const searchResults =
    currentSurface === "search" && query ? await searchMailbox(query) : [];
  const filteredThreads = filterByView(mailboxThreads, currentView);
  const importantThreads =
    currentView === "all" && !query
      ? filteredThreads.filter((thread) => hasInvookLabel(thread, "important"))
      : [];
  const remainingThreads =
    currentView === "all" && !query
      ? filteredThreads.filter((thread) => !hasInvookLabel(thread, "important"))
      : filteredThreads;

  let centerPane: React.ReactNode;
  if (selectedThread) {
    centerPane = (
      <ThreadReader
        thread={selectedThread}
        currentView={currentView}
        aiConfigured={workspace.aiConfigured}
      />
    );
  } else if (currentSurface === "compose") {
    centerPane = <ComposeSurface />;
  } else if (currentSurface === "search" && !query) {
    centerPane = <SearchSurface />;
  } else if (currentSurface === "search" && query) {
    centerPane = <SearchResultsSurface query={query} results={searchResults} />;
  } else if (currentSurface === "settings") {
    centerPane = (
      <SettingsSurface
        memories={workspace.memories}
        syncState={workspace.account.syncState.memory}
        aiConfigured={workspace.aiConfigured}
      />
    );
  } else if (currentSurface === "automations") {
    centerPane = <PendingSurface />;
  } else {
    centerPane = (
      <MailList
        account={workspace.account}
        currentView={currentView}
        importantThreads={importantThreads}
        remainingThreads={remainingThreads}
        query={currentSurface === "search" ? query : undefined}
      />
    );
  }

  return (
    <main className="h-dvh overflow-hidden bg-background">
      <div className="grid h-full grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(520px,1fr)_360px]">
        <MailSidebar
          email={workspace.account.email}
          currentView={currentView}
          currentSurface={currentSurface}
          memoryProgress={workspace.memoryProgress}
        />
        {centerPane}
        <AgentPanel
          openThreadId={selectedThread?.id}
          openThreadSubject={selectedThread?.subject || undefined}
          aiConfigured={workspace.aiConfigured}
          indexingState={workspace.account.syncState.indexing}
        />
      </div>
    </main>
  );
}
