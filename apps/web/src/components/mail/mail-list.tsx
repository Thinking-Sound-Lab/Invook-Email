import {
  MoreHorizontalIcon,
  RefreshIcon,
  Search02Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { formatMailDate, initials, threadPeople } from "./mail-format";
import type { MailAccount, MailboxView, MailThreadSummary } from "./types";

const viewTitles: Record<MailboxView, string> = {
  all: "All mail",
  travel: "Travel",
  important: "Important",
  pitch: "Pitch",
  newsletter: "Newsletter",
  starred: "Starred",
  shared: "Shared",
  reminders: "Reminders",
  scheduled: "Scheduled",
  drafts: "Drafts",
  done: "Done",
  sent: "Sent",
  trash: "Trash",
};

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

  return (
    <Link
      href={`/mail?view=${currentView}&thread=${thread.id}`}
      scroll={false}
      className={cn(
        "group relative grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3 border-b border-border/70 px-4 py-3 transition-colors",
        "hover:bg-accent/45 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        unread && "bg-card/45",
      )}
    >
      {important ? (
        <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-warning" />
      ) : null}
      <Avatar className="mt-0.5 size-8 rounded-lg">
        <AvatarFallback className="rounded-lg bg-secondary text-[10px] font-semibold text-secondary-foreground">
          {initials(people)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className={cn("truncate text-[13px]", unread ? "font-semibold" : "font-medium")}>
            {people}
          </p>
          {thread.messageCount > 1 ? (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {thread.messageCount}
            </span>
          ) : null}
          {starred ? (
            <HugeiconsIcon
              icon={StarIcon}
              size={12}
              className="shrink-0 text-warning"
              fill="currentColor"
            />
          ) : null}
        </div>
        <p className={cn("mt-0.5 truncate text-[12px]", unread ? "text-foreground" : "text-foreground/80")}>
          {thread.subject || "(No subject)"}
        </p>
        <p className="mt-1 line-clamp-1 text-[11px] leading-4 text-muted-foreground">
          {thread.snippet || "No message preview is available."}
        </p>
        {thread.invookLabels.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {thread.invookLabels.slice(0, 3).map((label) => (
              <Badge
                key={label.key}
                variant="outline"
                className="h-4 rounded px-1 text-[8px] font-medium capitalize text-muted-foreground"
              >
                {label.key}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <time className="pt-0.5 text-[10px] tabular-nums text-muted-foreground">
        {formatMailDate(thread.latestMessageAt)}
      </time>
    </Link>
  );
}

function MailSection({
  title,
  threads,
  accountEmail,
  currentView,
  important = false,
}: {
  title: string;
  threads: MailThreadSummary[];
  accountEmail: string;
  currentView: MailboxView;
  important?: boolean;
}) {
  return (
    <section aria-labelledby={`${title.toLowerCase().replaceAll(" ", "-")}-heading`}>
      <div className="flex h-9 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          {important ? <span className="size-1.5 rounded-full bg-warning" /> : null}
          <h2
            id={`${title.toLowerCase().replaceAll(" ", "-")}-heading`}
            className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            {title}
          </h2>
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground">{threads.length}</span>
      </div>

      {threads.length > 0 ? (
        threads.map((thread) => (
          <MailRow
            key={thread.id}
            thread={thread}
            accountEmail={accountEmail}
            currentView={currentView}
            important={important}
          />
        ))
      ) : (
        <p className="px-4 pb-5 pt-1 text-xs text-muted-foreground">
          No indexed Gmail threads in this section.
        </p>
      )}
    </section>
  );
}

export function MailList({
  account,
  currentView,
  importantThreads,
  remainingThreads,
  query,
  aiConfigured,
}: {
  account: MailAccount;
  currentView: MailboxView;
  importantThreads: MailThreadSummary[];
  remainingThreads: MailThreadSummary[];
  query?: string;
  aiConfigured: boolean;
}) {
  const noIndexedMail = importantThreads.length === 0 && remainingThreads.length === 0;
  const indexing = account.syncState.recent === "pending" || account.syncState.recent === "running";
  const learning =
    !indexing &&
    (account.syncState.memory === "pending" || account.syncState.memory === "running");

  return (
    <section className="flex min-h-0 flex-col bg-background" aria-label="Mailbox">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold tracking-[-0.02em]">
              {query ? `Search: ${query}` : viewTitles[currentView]}
            </h1>
            {indexing || learning ? (
              <Badge variant="outline" className="h-5 border-border px-1.5 text-[9px] text-muted-foreground">
                {indexing
                  ? "Indexing"
                  : aiConfigured
                    ? "Building memory"
                    : "AI setup needed"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {account.email}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <Button asChild variant="ghost" size="icon-sm">
            <Link href="/mail?surface=search" aria-label="Search indexed mail">
              <HugeiconsIcon icon={Search02Icon} size={15} />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="icon-sm">
            <Link href={`/mail?view=${currentView}`} aria-label="Refresh mailbox">
              <HugeiconsIcon icon={RefreshIcon} size={15} />
            </Link>
          </Button>
          <Button variant="ghost" size="icon-sm" disabled aria-label="More mailbox actions">
            <HugeiconsIcon icon={MoreHorizontalIcon} size={15} />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {currentView === "all" && !query ? (
          <>
            <MailSection
              title="Important"
              threads={importantThreads}
              accountEmail={account.email}
              currentView={currentView}
              important
            />
            <div className="relative py-2">
              <Separator />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 bg-background px-2 text-[9px] uppercase tracking-[0.15em] text-muted-foreground/60">
                Everything else
              </span>
            </div>
            <MailSection
              title="All mail"
              threads={remainingThreads}
              accountEmail={account.email}
              currentView={currentView}
            />
          </>
        ) : (
          <MailSection
            title={query ? "Results" : viewTitles[currentView]}
            threads={remainingThreads}
            accountEmail={account.email}
            currentView={currentView}
            important={currentView === "important"}
          />
        )}

        {noIndexedMail && indexing ? (
          <div className="mx-4 mt-2 rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">
            Gmail indexing is still running. Real threads will appear here as they are stored.
          </div>
        ) : null}
      </ScrollArea>
    </section>
  );
}
