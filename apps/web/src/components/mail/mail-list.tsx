import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Search02Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MailboxPagination } from "@invook/contracts";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { createMailDateSections } from "./mail-date-sections";
import { formatMailDate, formatMailText, threadPeople } from "./mail-format";
import { MailboxRefreshButton } from "./mailbox-refresh-button";
import { MailNavigationPending } from "./mail-navigation-pending";
import { listMailRowLabels, type MailRowLabel } from "./mail-row-labels";
import type {
  MailAccount,
  MailboxView,
  MailThreadSummary,
  StaticMailboxView,
} from "./types";

const viewTitles: Record<StaticMailboxView, string> = {
  all: "All mail",
  starred: "Starred",
  drafts: "Drafts",
  sent: "Sent",
  spam: "Spam",
  trash: "Trash",
};

function mailboxHref(
  currentView: MailboxView,
  cursor?: string | null,
  threadId?: string,
): string {
  const query = new URLSearchParams({ view: currentView });
  if (cursor) query.set("cursor", cursor);
  if (threadId) query.set("thread", threadId);
  return `/mail?${query.toString()}`;
}

interface MailRowProps {
  thread: MailThreadSummary;
  accountEmail: string;
  currentView: MailboxView;
  mailboxCursor?: string;
}

interface MailLabelChipProps {
  label: MailRowLabel;
}

function MailLabelChip({ label }: MailLabelChipProps) {
  const sourceName = label.kind === "gmail" ? "Gmail" : "Invook";

  return (
    <span
      aria-label={`${label.name}, ${sourceName} label`}
      title={`${label.name} (${sourceName})`}
      className={cn(
        "min-w-0 max-w-28 truncate rounded px-1.5 py-0.5 text-[11px] font-medium",
        label.kind === "gmail"
          ? "bg-secondary text-muted-foreground"
          : "bg-primary/12 text-primary",
      )}
    >
      {label.name}
    </span>
  );
}

function MailRow({
  thread,
  accountEmail,
  currentView,
  mailboxCursor,
}: MailRowProps) {
  const people = threadPeople(thread.participants, accountEmail);
  const isUnread = thread.gmailLabels.some(
    (label) => label.providerLabelId === "UNREAD",
  );
  const isStarred = thread.gmailLabels.some(
    (label) => label.providerLabelId === "STARRED",
  );
  const labels = listMailRowLabels(thread);

  return (
    <Link
      href={mailboxHref(currentView, mailboxCursor, thread.id)}
      scroll={false}
      className={cn(
        "group relative grid min-h-12 grid-cols-[minmax(118px,0.3fr)_minmax(0,1fr)_auto] items-center gap-4 border-b border-border/45 px-5 py-2.5 transition-colors",
        "hover:bg-accent/55 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isUnread && "bg-card/45",
      )}
    >
      <MailNavigationPending variant="edge" />
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isUnread ? "bg-blue-500" : "bg-transparent",
          )}
        />
        <span className="sr-only">{isUnread ? "Unread" : "Read"}</span>
        <p
          className={cn(
            "truncate text-sm",
            isUnread
              ? "font-semibold"
              : "font-normal text-foreground/70",
          )}
        >
          {people}
          {thread.messageCount > 1 ? (
            <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {thread.messageCount}
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <p
          className={cn(
            "shrink-0 truncate text-sm",
            isUnread
              ? "max-w-[48%] font-semibold"
              : "max-w-[42%] font-normal text-foreground/76",
          )}
        >
          {formatMailText(thread.subject) || "(No subject)"}
        </p>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {formatMailText(thread.snippet) || "No message preview is available."}
        </p>
        {labels.length > 0 ? (
          <div
            className="hidden min-w-0 max-w-[40%] shrink items-center gap-1 overflow-hidden lg:flex"
            aria-label="User-created labels"
          >
            {labels.map((label) => (
              <MailLabelChip key={`${label.kind}:${label.id}`} label={label} />
            ))}
          </div>
        ) : null}
        {isStarred ? (
          <HugeiconsIcon icon={StarIcon} size={13} className="shrink-0 text-warning" fill="currentColor" />
        ) : null}
      </div>

      <time className="text-xs tabular-nums text-muted-foreground">
        {formatMailDate(thread.latestMessageAt)}
      </time>
    </Link>
  );
}

interface MailRowsProps {
  threads: MailThreadSummary[];
  accountEmail: string;
  currentView: MailboxView;
  mailboxCursor?: string;
}

function MailRows({
  threads,
  accountEmail,
  currentView,
  mailboxCursor,
}: MailRowsProps) {
  const sections = createMailDateSections(threads);

  return sections.map((section, sectionIndex) => (
    <section
      key={section.id}
      aria-label={section.label ?? "Today"}
      className={cn(section.label && (sectionIndex === 0 ? "pt-4" : "pt-6"))}
    >
      {section.label ? (
        <h2 className="px-5 pb-2 text-xs font-medium text-muted-foreground">
          {section.label}
        </h2>
      ) : null}
      {section.threads.map((thread) => (
        <MailRow
          key={thread.id}
          thread={thread}
          accountEmail={accountEmail}
          currentView={currentView}
          mailboxCursor={mailboxCursor}
        />
      ))}
    </section>
  ));
}

export interface MailListProps {
  account: MailAccount;
  currentView: MailboxView;
  mailboxCursor?: string;
  pagination: MailboxPagination;
  threads: MailThreadSummary[];
  query?: string;
  title?: string;
}

export function MailList({
  account,
  currentView,
  mailboxCursor,
  pagination,
  threads,
  query,
  title,
}: MailListProps) {
  const noMail = threads.length === 0;
  const syncing =
    account.syncState.mailSync === "pending" || account.syncState.mailSync === "running";

  return (
    <section
      className="mx-4 flex min-h-0 flex-col bg-background"
      aria-label="Mailbox"
    >
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
          <span className="mr-1 hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {pagination.totalThreadCount.toLocaleString()} threads
          </span>
          {pagination.newerCursor ? (
            <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
              <Link
                href={mailboxHref(currentView, pagination.newerCursor)}
                aria-label="Show newer mail"
                scroll={false}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="icon-sm" disabled aria-label="No newer mail">
              <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
            </Button>
          )}
          {pagination.olderCursor ? (
            <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
              <Link
                href={mailboxHref(currentView, pagination.olderCursor)}
                aria-label="Show older mail"
                scroll={false}
              >
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="icon-sm" disabled aria-label="No older mail">
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
            </Button>
          )}
          <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
            <Link href="/mail?surface=search" aria-label="Search mail">
              <HugeiconsIcon icon={Search02Icon} size={16} />
            </Link>
          </Button>
          <MailboxRefreshButton />
        </div>
      </header>

      <ScrollArea type="always" className="min-h-0 flex-1">
        <MailRows
          threads={threads}
          accountEmail={account.email}
          currentView={currentView}
          mailboxCursor={mailboxCursor}
        />

        {noMail ? (
          <div className="mx-auto max-w-sm px-6 py-20 text-center">
            <p className="text-sm font-medium">
              {syncing ? "Syncing Gmail" : "No mail in this view"}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {syncing
                ? "Messages will appear here as Invook stores them."
                : "This view has no synchronized Gmail threads."}
            </p>
          </div>
        ) : null}
      </ScrollArea>
    </section>
  );
}
