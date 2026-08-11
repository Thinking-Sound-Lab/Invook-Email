import { Search02Icon, StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { formatMailDate, formatMailText, threadPeople } from "./mail-format";
import { MailboxRefreshButton } from "./mailbox-refresh-button";
import type {
  MailAccount,
  MailboxView,
  MailThreadSummary,
  StaticMailboxView,
} from "./types";

const viewTitles: Record<StaticMailboxView, string> = {
  all: "All mail",
  starred: "Starred",
  shared: "Shared",
  reminders: "Reminders",
  scheduled: "Scheduled",
  drafts: "Drafts",
  done: "Done",
  sent: "Sent",
  trash: "Trash",
};

const labelStyles = {
  important: "bg-violet-400/14 text-violet-200",
  travel: "bg-sky-400/14 text-sky-200",
  pitch: "bg-rose-400/14 text-rose-200",
  newsletter: "bg-emerald-400/14 text-emerald-200",
} as const;

function MailRow({
  thread,
  accountEmail,
  currentView,
  important,
}: {
  thread: MailThreadSummary;
  accountEmail: string;
  currentView: MailboxView;
  important: boolean;
}) {
  const people = threadPeople(thread.participants, accountEmail);
  const unread = thread.labelIds.includes("UNREAD");
  const starred = thread.labelIds.includes("STARRED");
  const primaryLabel = thread.invookLabels[0];

  return (
    <Link
      href={`/mail?view=${currentView}&thread=${thread.id}`}
      scroll={false}
      className={cn(
        "group relative grid min-h-12 grid-cols-[minmax(118px,0.3fr)_minmax(0,1fr)_auto] items-center gap-4 border-b border-border/45 px-5 py-2.5 transition-colors",
        "hover:bg-accent/55 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        unread && "bg-card/45",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {important ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
        <p className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium text-foreground/78")}>
          {people}
          {thread.messageCount > 1 ? (
            <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {thread.messageCount}
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <p className={cn("shrink-0 truncate text-sm", unread ? "max-w-[48%] font-semibold" : "max-w-[42%] font-medium text-foreground/86")}>
          {formatMailText(thread.subject) || "(No subject)"}
        </p>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {formatMailText(thread.snippet) || "No message preview is available."}
        </p>
        {primaryLabel ? (
          <span
            className={cn(
              "hidden shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium capitalize 2xl:inline-flex",
              primaryLabel.systemKey
                ? labelStyles[primaryLabel.systemKey]
                : "bg-secondary text-muted-foreground",
            )}
          >
            {primaryLabel.name}
          </span>
        ) : null}
        {starred ? (
          <HugeiconsIcon icon={StarIcon} size={13} className="shrink-0 text-warning" fill="currentColor" />
        ) : null}
      </div>

      <time className="text-xs tabular-nums text-muted-foreground">
        {formatMailDate(thread.latestMessageAt)}
      </time>
    </Link>
  );
}

function MailRows({
  threads,
  accountEmail,
  currentView,
  important = false,
}: {
  threads: MailThreadSummary[];
  accountEmail: string;
  currentView: MailboxView;
  important?: boolean;
}) {
  return threads.map((thread) => (
    <MailRow
      key={thread.id}
      thread={thread}
      accountEmail={accountEmail}
      currentView={currentView}
      important={important}
    />
  ));
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-3 px-5">
      <span className="h-px flex-1 bg-border/55" />
      <p className="text-xs font-medium text-muted-foreground">{children}</p>
      <span className="h-px flex-1 bg-border/55" />
    </div>
  );
}

export function MailList({
  account,
  currentView,
  importantThreads,
  remainingThreads,
  query,
  title,
  importantView = false,
}: {
  account: MailAccount;
  currentView: MailboxView;
  importantThreads: MailThreadSummary[];
  remainingThreads: MailThreadSummary[];
  query?: string;
  title?: string;
  importantView?: boolean;
}) {
  const noIndexedMail = importantThreads.length === 0 && remainingThreads.length === 0;
  const indexing = account.syncState.recent === "pending" || account.syncState.recent === "running";

  return (
    <section className="flex min-h-0 flex-col bg-background" aria-label="Mailbox">
      <header className="flex h-15 shrink-0 items-center justify-between border-b border-border/45 px-5">
        <h1 className="truncate text-base font-semibold tracking-[-0.025em]">
          {query
            ? `Search: ${query}`
            : title ??
              (currentView.startsWith("label:")
                ? "Label"
                : viewTitles[currentView as StaticMailboxView])}
        </h1>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
            <Link href="/mail?surface=search" aria-label="Search indexed mail">
              <HugeiconsIcon icon={Search02Icon} size={16} />
            </Link>
          </Button>
          <MailboxRefreshButton />
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {currentView === "all" && !query ? (
          <>
            {importantThreads.length > 0 ? (
              <MailRows
                threads={importantThreads}
                accountEmail={account.email}
                currentView={currentView}
                important
              />
            ) : null}
            {importantThreads.length > 0 && remainingThreads.length > 0 ? (
              <SectionLabel>All mail</SectionLabel>
            ) : null}
            <MailRows
              threads={remainingThreads}
              accountEmail={account.email}
              currentView={currentView}
            />
          </>
        ) : (
          <MailRows
            threads={remainingThreads}
            accountEmail={account.email}
            currentView={currentView}
            important={importantView}
          />
        )}

        {noIndexedMail ? (
          <div className="mx-auto max-w-sm px-6 py-20 text-center">
            <p className="text-sm font-medium">
              {indexing ? "Scanning Gmail" : "No mail in this view"}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {indexing
                ? "Messages will appear here as Invook stores them."
                : "This view has no indexed Gmail threads."}
            </p>
          </div>
        ) : null}
      </ScrollArea>
    </section>
  );
}
