import {
  Delete02Icon,
  FileEditIcon,
  InboxIcon,
  Mail01Icon,
  PencilEdit01Icon,
  Search02Icon,
  SentIcon,
  Settings01Icon,
  SpamIcon,
  StarIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import {
  PREVIEW_ACCOUNTS,
  PREVIEW_TODAY_THREADS,
  PREVIEW_USER,
  PREVIEW_YESTERDAY_THREADS,
  type PreviewAccountKey,
  type PreviewLabelName,
  type PreviewThread,
} from "./preview-mailbox";
import {
  PreviewAccountAvatar,
  PreviewLabelChip,
  PreviewStage,
  PreviewSurface,
} from "./preview-primitives";

const sidebarLabelCounts = [
  { label: "Important", count: 12 },
  { label: "Clients", count: 4 },
  { label: "Newsletter", count: 9 },
  { label: "Billing", count: 3 },
  { label: "Others", count: 6 },
] as const satisfies ReadonlyArray<{ label: PreviewLabelName; count: number }>;

const sidebarMailItems = [
  { label: "All", icon: InboxIcon, count: 34 },
  { label: "Starred", icon: StarIcon, count: 5 },
  { label: "Drafts", icon: FileEditIcon, count: 2 },
  { label: "Sent", icon: SentIcon },
  { label: "Spam", icon: SpamIcon },
  { label: "Trash", icon: Delete02Icon },
] as const;

interface PreviewNavItemProps {
  label: string;
  icon?: IconSvgElement;
  count?: number;
  isActive?: boolean;
  trailing?: ReactNode;
}

function PreviewNavItem({ label, icon, count, isActive = false, trailing }: PreviewNavItemProps) {
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground/58",
        isActive && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      {icon ? <HugeiconsIcon icon={icon} size={15} strokeWidth={1.65} className="shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : (
        <span className="shrink-0 text-[11px] font-normal tabular-nums text-sidebar-foreground/38">
          {count}
        </span>
      )}
      {trailing}
    </div>
  );
}

function PreviewSidebarHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 mt-5 px-2.5 text-xs font-medium text-sidebar-foreground/35">{children}</p>
  );
}

function PreviewSidebar() {
  return (
    <div className="hidden min-h-0 flex-col overflow-hidden bg-sidebar px-3 py-3 lg:flex">
      <div className="flex h-11 items-center gap-2.5 px-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
          {PREVIEW_USER.initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">{PREVIEW_USER.name}</p>
          <p className="truncate text-xs text-sidebar-foreground/45">{PREVIEW_USER.email}</p>
        </div>
      </div>

      <div className="mt-3 space-y-0.5">
        <PreviewNavItem label="Compose" icon={PencilEdit01Icon} />
        <PreviewNavItem label="Search" icon={Search02Icon} />
        <PreviewNavItem label="Settings" icon={Settings01Icon} />
      </div>

      <PreviewSidebarHeading>Labels</PreviewSidebarHeading>
      <div className="space-y-0.5">
        {sidebarLabelCounts.map((item) => (
          <PreviewNavItem key={item.label} label={item.label} count={item.count} />
        ))}
      </div>

      <PreviewSidebarHeading>Mail</PreviewSidebarHeading>
      <div className="space-y-0.5">
        {sidebarMailItems.map((item) => (
          <PreviewNavItem
            key={item.label}
            label={item.label}
            icon={item.icon}
            count={"count" in item ? item.count : undefined}
            isActive={item.label === "All"}
          />
        ))}
      </div>

      <PreviewSidebarHeading>Inboxes</PreviewSidebarHeading>
      <div className="space-y-0.5">
        <PreviewNavItem
          label="All"
          isActive
          trailing={<HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.8} className="shrink-0 text-sidebar-foreground/65" />}
        />
        {(Object.keys(PREVIEW_ACCOUNTS) as PreviewAccountKey[]).map((account) => (
          <div key={account} className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-sidebar-foreground/58">
            <PreviewAccountAvatar account={account} className="ring-offset-sidebar" />
            <span className="min-w-0 flex-1 truncate">{PREVIEW_ACCOUNTS[account].email}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewThreadRow({ thread }: { thread: PreviewThread }) {
  return (
    <div
      className={cn(
        "grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-border/40 px-4 py-2",
        "@2xl:grid-cols-[minmax(112px,0.3fr)_minmax(0,1fr)_6.5rem_1rem_6rem] @2xl:gap-2.5",
        thread.isUnread && "bg-card/45",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", thread.isUnread ? "bg-primary-blue" : "bg-transparent")}
        />
        <p className={cn("truncate text-sm", thread.isUnread ? "font-semibold" : "text-foreground/70")}>
          {thread.people}
          {thread.messageCount ? (
            <span className="ml-1.5 text-xs font-normal tabular-nums text-muted-foreground">
              {thread.messageCount}
            </span>
          ) : null}
        </p>
      </div>

      <div className="col-start-1 row-start-2 flex min-w-0 items-center gap-2 pl-3.5 @2xl:col-start-auto @2xl:row-start-auto @2xl:pl-0">
        <p
          className={cn(
            "min-w-0 truncate text-sm @2xl:max-w-[48%] @2xl:shrink-0",
            thread.isUnread ? "font-semibold" : "text-foreground/76",
          )}
        >
          {thread.subject}
        </p>
        <p className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground @2xl:block">
          {thread.snippet}
        </p>
      </div>

      <div className="col-start-2 row-span-2 row-start-1 flex min-w-0 justify-end @2xl:col-start-auto @2xl:row-span-1 @2xl:row-start-auto">
        <PreviewLabelChip label={thread.label} />
      </div>

      <div className="hidden size-4 items-center justify-center @2xl:flex">
        {thread.isStarred ? (
          <HugeiconsIcon icon={StarIcon} size={13} className="text-warning" fill="currentColor" />
        ) : null}
      </div>

      <div className="hidden items-center justify-end gap-2 @2xl:flex">
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {thread.receivedAt}
        </span>
        <PreviewAccountAvatar account={thread.account} className="size-4.5" />
      </div>
    </div>
  );
}

function PreviewThreadList() {
  return (
    <div className="@container flex min-w-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center px-4">
        <p className="text-base font-semibold tracking-[-0.025em]">All</p>
      </div>
      <div>
        {PREVIEW_TODAY_THREADS.map((thread) => (
          <PreviewThreadRow key={thread.subject} thread={thread} />
        ))}
      </div>
      <div className="pt-5">
        <p className="px-4 pb-1.5 text-xs font-medium text-muted-foreground">Yesterday</p>
        {PREVIEW_YESTERDAY_THREADS.map((thread) => (
          <PreviewThreadRow key={thread.subject} thread={thread} />
        ))}
      </div>
    </div>
  );
}

export interface ProductPreviewProps {
  className?: string;
}

export function ProductPreview({ className }: ProductPreviewProps) {
  return (
    <PreviewStage
      tone="dusk"
      label="The Invook mailbox: two Gmail accounts in one list, with every thread labeled Important, Clients, Newsletter, Billing, or Others."
      className={cn("p-3 sm:p-6 lg:p-10", className)}
    >
      <PreviewSurface className="relative">
        <div className="flex h-9 items-center gap-1.5 bg-sidebar px-4">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
            <HugeiconsIcon icon={Mail01Icon} size={12} strokeWidth={1.7} />
            Invook
          </span>
        </div>
        <div className="grid h-[30rem] grid-cols-1 overflow-hidden sm:h-[34rem] lg:grid-cols-[232px_minmax(0,1fr)]">
          <PreviewSidebar />
          <PreviewThreadList />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-linear-to-t from-background to-transparent" />
      </PreviewSurface>
    </PreviewStage>
  );
}
