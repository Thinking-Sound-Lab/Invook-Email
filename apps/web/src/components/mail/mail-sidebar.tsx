import {
  AiMagicIcon,
  Delete02Icon,
  FileEditIcon,
  InboxIcon,
  Mail01Icon,
  PencilEdit01Icon,
  Search02Icon,
  SentIcon,
  SpamIcon,
  StarIcon,
  Tag01Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  GmailUserLabel,
  InvookLabel,
  MailboxAccount,
  MemoryEntry,
} from "@invook/contracts";
import Link from "next/link";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { cn } from "@/lib/utils";

import { AccountPipelineProgress } from "./account-pipeline-progress";
import { initials } from "./mail-format";
import { MailNavigationPending } from "./mail-navigation-pending";
import { listSidebarLabels } from "./mail-sidebar-labels";
import type { MailboxView, MailSurface } from "./types";

const workspaceItems = [
  { label: "Compose", icon: PencilEdit01Icon, surface: "compose" },
  { label: "Search", icon: Search02Icon, surface: "search" },
] as const;

const automationsItem = {
  label: "Automations",
  icon: WorkflowSquare01Icon,
  surface: "automations",
} as const;

const mailItems = [
  { label: "Starred", icon: StarIcon, view: "starred" },
  { label: "Drafts", icon: FileEditIcon, view: "drafts" },
  { label: "Sent", icon: SentIcon, view: "sent" },
  { label: "Spam", icon: SpamIcon, view: "spam" },
  { label: "Trash", icon: Delete02Icon, view: "trash" },
] as const;

interface NavLinkProps {
  label: string;
  icon: typeof Mail01Icon;
  active: boolean;
  href: string;
}

function navItemClassName(active: boolean): string {
  return cn(
    "group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground/58 transition-colors",
    "hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active && "bg-sidebar-accent text-sidebar-foreground",
  );
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
      className={navItemClassName(active)}
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.65} className="shrink-0" />
      <span className="hidden truncate lg:block">{label}</span>
      <MailNavigationPending />
    </Link>
  );
}

export interface MailSidebarProps {
  account: MailboxAccount;
  currentView: MailboxView;
  currentSurface: MailSurface;
  memories: MemoryEntry[];
  gmailUserLabels: GmailUserLabel[];
  invookLabels: InvookLabel[];
  aiConfigured: boolean;
  batchConfigured: boolean;
}

export function MailSidebar({
  account,
  currentView,
  currentSurface,
  memories,
  gmailUserLabels,
  invookLabels,
  aiConfigured,
  batchConfigured,
}: MailSidebarProps) {
  const labels = listSidebarLabels({ gmailUserLabels, invookLabels });

  return (
    <aside className="flex min-h-0 flex-col bg-sidebar px-2 py-3 lg:px-3" aria-label="Mailbox navigation">
      <div className="flex h-11 items-center gap-2.5 px-1.5 lg:px-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
          {initials(account.email)}
        </span>
        <div className="hidden min-w-0 flex-1 lg:block">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">Invook</p>
          <p className="truncate text-xs text-sidebar-foreground/45">{account.email}</p>
        </div>
        <div className="hidden lg:block">
          <SignOutButton isIconOnly />
        </div>
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
        <SettingsDialog
          account={account}
          memories={memories}
          gmailUserLabels={gmailUserLabels}
          invookLabels={invookLabels}
          aiConfigured={aiConfigured}
          batchConfigured={batchConfigured}
          triggerClassName={navItemClassName(false)}
        />
        <NavLink
          label={automationsItem.label}
          icon={automationsItem.icon}
          active={currentSurface === automationsItem.surface}
          href={`/mail?surface=${automationsItem.surface}`}
        />
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
                icon={label.kind === "gmail" ? Tag01Icon : AiMagicIcon}
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

      <AccountPipelineProgress
        initialProgress={{
          mailSync: account.mailSyncProgress,
          indexing: account.indexingProgress,
          memory: account.syncState.memory,
        }}
      />
    </aside>
  );
}
