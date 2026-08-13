import {
  Airplane01Icon,
  CloudSyncIcon,
  Delete02Icon,
  FileEditIcon,
  HonourStarIcon,
  InboxIcon,
  Logout01Icon,
  Mail01Icon,
  Megaphone01Icon,
  News01Icon,
  PencilEdit01Icon,
  Search02Icon,
  SentIcon,
  Settings01Icon,
  StarIcon,
  Tag01Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  MailLabel,
  MailSyncProgress,
  SystemLabelKey,
} from "@invook/contracts";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import { initials } from "./mail-format";
import { getGmailSyncProgressPresentation } from "./gmail-sync-progress";
import type { MailboxView, MailSurface } from "./types";

const workspaceItems = [
  { label: "Compose", icon: PencilEdit01Icon, surface: "compose" },
  { label: "Search", icon: Search02Icon, surface: "search" },
  { label: "Settings", icon: Settings01Icon, surface: "settings" },
  { label: "Automations", icon: WorkflowSquare01Icon, surface: "automations" },
] as const;

const labelIcons = {
  important: HonourStarIcon,
  travel: Airplane01Icon,
  pitch: Megaphone01Icon,
  newsletter: News01Icon,
} satisfies Record<SystemLabelKey, typeof Tag01Icon>;

const mailItems = [
  { label: "Starred", icon: StarIcon, view: "starred" },
  { label: "Drafts", icon: FileEditIcon, view: "drafts" },
  { label: "Sent", icon: SentIcon, view: "sent" },
  { label: "Trash", icon: Delete02Icon, view: "trash" },
] as const;

interface NavLinkProps {
  label: string;
  icon: typeof Mail01Icon;
  active: boolean;
  href: string;
}

function NavLink({
  label,
  icon,
  active,
  href,
}: NavLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground/58 transition-colors",
        "hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.65} className="shrink-0" />
      <span className="hidden truncate lg:block">{label}</span>
    </Link>
  );
}

interface GmailSyncProgressProps {
  progress: MailSyncProgress;
}

function GmailSyncProgress({ progress }: GmailSyncProgressProps) {
  const presentation = getGmailSyncProgressPresentation(progress);
  if (!presentation) return null;
  const { title, detail, percentage, isFailed } = presentation;

  return (
    <div
      role={isFailed ? "alert" : "status"}
      aria-live="polite"
      className="hidden px-2 pb-1 lg:block"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <HugeiconsIcon
            icon={CloudSyncIcon}
            size={14}
            strokeWidth={1.7}
            className={cn(
              "shrink-0 text-primary",
              isFailed && "text-destructive",
            )}
          />
          <p className="truncate text-[13px] font-semibold text-sidebar-foreground">{title}</p>
        </div>
        {percentage !== null ? (
          <span className="text-xs tabular-nums text-sidebar-foreground/55">
            {percentage}%
          </span>
        ) : null}
      </div>
      <Progress
        value={percentage}
        aria-label={title}
        className={cn(
          "mt-2 h-1 bg-sidebar-accent",
          isFailed && "[&_[data-slot=progress-indicator]]:bg-destructive",
        )}
      />
      <p className="mt-2 text-xs leading-4 text-sidebar-foreground/48">{detail}</p>
    </div>
  );
}

export interface MailSidebarProps {
  email: string;
  currentView: MailboxView;
  currentSurface: MailSurface;
  syncProgress: MailSyncProgress;
  labels: MailLabel[];
}

export function MailSidebar({
  email,
  currentView,
  currentSurface,
  syncProgress,
  labels,
}: MailSidebarProps) {
  return (
    <aside className="flex min-h-0 flex-col bg-sidebar px-2 py-3 lg:px-3" aria-label="Mailbox navigation">
      <div className="flex h-11 items-center gap-2.5 px-1.5 lg:px-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
          {initials(email)}
        </span>
        <div className="hidden min-w-0 flex-1 lg:block">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">Invook</p>
          <p className="truncate text-xs text-sidebar-foreground/45">{email}</p>
        </div>
        <form action="/v1/auth/sign-out" method="post" className="hidden lg:block">
          <Button
            variant="ghost"
            size="icon-xs"
            type="submit"
            aria-label="Sign out"
            className="text-sidebar-foreground/45 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <HugeiconsIcon icon={Logout01Icon} size={14} />
          </Button>
        </form>
      </div>

      <nav className="mt-3 space-y-0.5" aria-label="Workspace">
        {workspaceItems.map((item) => (
          <NavLink
            key={item.label}
            label={item.label}
            icon={item.icon}
            active={currentSurface === item.surface}
            href={`/mail?surface=${item.surface}`}
          />
        ))}
      </nav>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1.5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Labels
        </p>
        <nav className="space-y-0.5" aria-label="Labels">
          <NavLink
            label="All"
            icon={InboxIcon}
            active={currentSurface === "mail" && currentView === "all"}
            href="/mail?view=all"
          />
          {labels.map((label) => {
            const view = `label:${label.id}` as const;
            return (
              <NavLink
                key={label.id}
                label={label.name}
                icon={label.systemKey ? labelIcons[label.systemKey] : Tag01Icon}
                active={currentSurface === "mail" && currentView === view}
                href={`/mail?view=${view}`}
              />
            );
          })}
        </nav>

        <p className="mb-1.5 mt-5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Mail
        </p>
        <nav className="space-y-0.5" aria-label="Mail">
          {mailItems.map((item) => (
            <NavLink
              key={item.label}
              label={item.label}
              icon={item.icon}
              active={currentSurface === "mail" && currentView === item.view}
              href={`/mail?view=${item.view}`}
            />
          ))}
        </nav>
      </div>

      <GmailSyncProgress progress={syncProgress} />
    </aside>
  );
}
