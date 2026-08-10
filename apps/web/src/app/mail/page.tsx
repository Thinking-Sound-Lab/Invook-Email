import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { MailLabel } from "@invook/contracts";

import { AgentPanel } from "@/components/mail/agent-panel";
import { MailList } from "@/components/mail/mail-list";
import { MailSidebar } from "@/components/mail/mail-sidebar";
import { ThreadReader } from "@/components/mail/thread-reader";
import type {
  MailboxView,
  MailSurface,
  MailThreadSummary,
  SelectedThread,
  StaticMailboxView,
} from "@/components/mail/types";
import {
  ComposeSurface,
  PendingSurface,
  SearchSurface,
  SettingsSurface,
} from "@/components/mail/workspace-surface";
import { getMailboxWorkspace } from "@/lib/api";

type MailPageProps = {
  searchParams: Promise<{
    view?: string | string[];
    surface?: string | string[];
    thread?: string | string[];
    q?: string | string[];
  }>;
};

const mailboxViews = new Set<StaticMailboxView>([
  "all",
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

function normalizeView(value: string | undefined, labels: MailLabel[]): MailboxView {
  if (value && mailboxViews.has(value as StaticMailboxView)) {
    return value as StaticMailboxView;
  }
  if (value?.startsWith("label:")) {
    const labelId = value.slice("label:".length);
    if (labels.some((label) => label.id === labelId)) return `label:${labelId}`;
  }
  return "all";
}

function normalizeSurface(value: string | undefined): MailSurface {
  return value && mailSurfaces.has(value as MailSurface) ? (value as MailSurface) : "mail";
}

function hasLabel(thread: MailThreadSummary, ...labels: string[]): boolean {
  return labels.some((label) => thread.labelIds.includes(label));
}

function hasInvookLabel(
  thread: MailThreadSummary,
  systemKey: "important" | "travel" | "pitch" | "newsletter",
): boolean {
  return thread.invookLabels.some((label) => label.systemKey === systemKey);
}

function filterByView(threads: MailThreadSummary[], view: MailboxView): MailThreadSummary[] {
  if (view.startsWith("label:")) {
    const labelId = view.slice("label:".length);
    return threads.filter((thread) =>
      thread.invookLabels.some((label) => label.labelId === labelId),
    );
  }
  switch (view as StaticMailboxView) {
    case "all":
      return threads;
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
  return threads;
}

function filterByQuery(threads: MailThreadSummary[], query: string): MailThreadSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return threads;

  return threads.filter((thread) =>
    [thread.subject, thread.snippet, ...thread.participants]
      .join("\n")
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

export default async function MailPage({ searchParams }: MailPageProps) {
  await connection();
  const params = await searchParams;

  const requestedThreadId = firstValue(params.thread);
  const requestedSurface = normalizeSurface(firstValue(params.surface));
  const currentSurface = requestedThreadId ? "mail" : requestedSurface;
  const query = firstValue(params.q)?.trim();

  const workspace = await getMailboxWorkspace(requestedThreadId);
  if (!workspace) redirect("/");
  const currentView = normalizeView(firstValue(params.view), workspace.labels);
  const currentLabel = currentView.startsWith("label:")
    ? workspace.labels.find((label) => label.id === currentView.slice("label:".length))
    : null;

  const mailboxThreads = workspace.threads as MailThreadSummary[];
  const selectedThread = workspace.selectedThread as SelectedThread | null;
  const filteredThreads =
    currentSurface === "search" && query
      ? filterByQuery(mailboxThreads, query)
      : filterByView(mailboxThreads, currentView);
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
        availableLabels={workspace.labels}
      />
    );
  } else if (currentSurface === "compose") {
    centerPane = <ComposeSurface />;
  } else if (currentSurface === "search" && !query) {
    centerPane = <SearchSurface />;
  } else if (currentSurface === "settings") {
    centerPane = (
      <SettingsSurface
        memories={workspace.memories}
        syncState={workspace.account.syncState.memory}
        aiConfigured={workspace.aiConfigured}
        labels={workspace.labels}
        batchConfigured={workspace.batchConfigured}
      />
    );
  } else if (currentSurface === "automations") {
    centerPane = <PendingSurface />;
  } else {
    centerPane = (
      <MailList
        account={workspace.account}
        currentView={currentView}
        title={currentLabel?.name}
        importantThreads={importantThreads}
        remainingThreads={remainingThreads}
        query={currentSurface === "search" ? query : undefined}
        importantView={currentLabel?.systemKey === "important"}
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
          labels={workspace.labels}
        />
        {centerPane}
        <AgentPanel
          openThreadSubject={selectedThread?.subject || undefined}
          aiConfigured={workspace.aiConfigured}
        />
      </div>
    </main>
  );
}
