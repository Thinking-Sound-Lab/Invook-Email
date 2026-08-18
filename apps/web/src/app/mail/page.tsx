import { redirect } from "next/navigation";
import { v4 as uuidv4, validate as validateUuid } from "uuid";

import { mailboxViews } from "@invook/contracts";

import { AgentPanel } from "@/components/mail/agent-panel";
import { ComposeSurface } from "@/components/mail/compose-surface";
import { MailList } from "@/components/mail/mail-list";
import { ThreadReader } from "@/components/mail/thread-reader";
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
import {
  getMailboxThreadDetail,
  getMailboxThreadPage,
  searchMailbox,
} from "@/lib/api";

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
  const params = await searchParams;

  const requestedThreadId = firstValue(params.thread);
  const requestedSurface = normalizeSurface(firstValue(params.surface));
  const currentSurface = requestedThreadId ? "mail" : requestedSurface;
  const query = firstValue(params.q)?.trim();
  const mailboxCursor = firstValue(params.cursor)?.trim() || undefined;
  const currentView = normalizeView(firstValue(params.view));

  const [threadDetail, threadPage, searchResults] = await Promise.all([
    requestedThreadId ? getMailboxThreadDetail(requestedThreadId) : null,
    currentSurface === "mail" && !requestedThreadId
      ? getMailboxThreadPage({ cursor: mailboxCursor, view: currentView })
      : null,
    currentSurface === "search" && query ? searchMailbox(query) : [],
  ]);
  if (requestedThreadId && !threadDetail) redirect(`/mail?view=${currentView}`);
  if (currentSurface === "mail" && !requestedThreadId && !threadPage) redirect("/");
  const selectedThread = threadDetail?.thread as SelectedThread | undefined;

  let centerPane: React.ReactNode;
  if (selectedThread) {
    centerPane = (
      <ThreadReader
        thread={selectedThread}
        currentView={currentView}
        mailboxCursor={mailboxCursor}
        availableLabels={threadDetail?.invookLabels ?? []}
      />
    );
  } else if (currentSurface === "compose") {
    centerPane = <ComposeSurface />;
  } else if (currentSurface === "search" && !query) {
    centerPane = <SearchSurface />;
  } else if (currentSurface === "search" && query) {
    centerPane = <SearchResultsSurface query={query} results={searchResults} />;
  } else if (currentSurface === "automations") {
    centerPane = <PendingSurface />;
  } else {
    centerPane = (
      <MailList
        key={currentView}
        canonicalPageVersion={uuidv4()}
        currentView={currentView}
        initialOlderCursor={threadPage?.pagination.olderCursor ?? null}
        threads={(threadPage?.threads ?? []) as MailThreadSummary[]}
        query={currentSurface === "search" ? query : undefined}
      />
    );
  }

  return (
    <>
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
      />
    </>
  );
}
