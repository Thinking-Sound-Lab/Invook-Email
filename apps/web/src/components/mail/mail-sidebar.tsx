"use client";

import {
  AiMagicIcon,
  Delete02Icon,
  FileEditIcon,
  InboxIcon,
  LabelImportantIcon,
  Mail01Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Search02Icon,
  SentIcon,
  SpamIcon,
  StarIcon,
  Tick02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  MailboxSidebarCounts,
} from "@invook/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import { initials } from "./mail-format";
import { MailNavigationPending } from "./mail-navigation-pending";
import { useMailShell } from "./mail-shell-provider";
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

const sidebarCountFormatter = new Intl.NumberFormat("en-US");

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
  count?: number;
}

function navItemClassName(active: boolean): string {
  return cn(
    "group flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] font-medium text-sidebar-foreground/58 transition-colors",
    "hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active && "bg-sidebar-accent text-sidebar-foreground",
  );
}

function NavLink({
  label,
  icon,
  active,
  href,
  count,
}: NavLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={navItemClassName(active)}
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.65} className="shrink-0" />
      <span className="hidden min-w-0 flex-1 truncate lg:block">{label}</span>
      {count === undefined ? null : (
        <span className="hidden shrink-0 text-[11px] font-normal tabular-nums text-sidebar-foreground/38 lg:block">
          {sidebarCountFormatter.format(count)}
        </span>
      )}
      <MailNavigationPending />
    </Link>
  );
}

export interface MailSidebarProps {
  sidebarCounts: MailboxSidebarCounts | null;
}

export function MailSidebar({
  sidebarCounts,
}: MailSidebarProps) {
  const { account, aiConfigured, invookLabels, user } = useMailShell();
  const searchParams = useSearchParams();
  const requestedSurface = searchParams.get("surface");
  const currentSurface: MailSurface = searchParams.has("thread")
    ? "mail"
    : requestedSurface === "compose" ||
        requestedSurface === "search" ||
        requestedSurface === "automations"
      ? requestedSurface
      : "mail";
  const requestedView = searchParams.get("view");
  const currentView: MailboxView = requestedView?.startsWith("label:")
    ? (requestedView as `label:${string}`)
    : requestedView === "important" ||
        requestedView === "starred" ||
        requestedView === "drafts" ||
        requestedView === "sent" ||
        requestedView === "spam" ||
        requestedView === "trash"
      ? requestedView
      : "all";
  const labels = listSidebarLabels(invookLabels);
  const connectedAccountImage =
    account.image ??
    (account.email.toLowerCase() === user.email.toLowerCase()
      ? user.image
      : null);

  return (
    <aside className="flex min-h-0 flex-col bg-sidebar px-2 py-3 lg:px-3" aria-label="Mailbox navigation">
      <div className="flex h-11 items-center gap-2.5 px-1.5 lg:px-2">
        <Avatar className="size-8 border-0 after:border-0">
          {user.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
            {initials(user.name)}
          </AvatarFallback>
        </Avatar>
        <div className="hidden min-w-0 flex-1 lg:block">
          <p className="truncate text-sm font-semibold text-sidebar-foreground">
            {user.name}
          </p>
          <p className="truncate text-xs text-sidebar-foreground/45">{user.email}</p>
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
          aiConfigured={aiConfigured}
          triggerClassName={navItemClassName(false)}
        />
        <NavLink
          label={automationsItem.label}
          icon={automationsItem.icon}
          active={currentSurface === automationsItem.surface}
          href={`/mail?surface=${automationsItem.surface}`}
        />
      </nav>

      <div className="scrollbar-hidden mt-5 min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1.5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Labels
        </p>
        <nav className="space-y-0.5" aria-label="Labels">
          <NavLink
            label="Important"
            icon={LabelImportantIcon}
            active={currentSurface === "mail" && currentView === "important"}
            href="/mail?view=important"
            count={sidebarCounts?.views.important}
          />
          {labels.map((label) => {
            const view = `label:${label.id}` as const;
            return (
              <NavLink
                key={label.id}
                label={label.name}
                icon={AiMagicIcon}
                active={currentSurface === "mail" && currentView === view}
                href={`/mail?view=${view}`}
                count={sidebarCounts?.labels[label.id]}
              />
            );
          })}
        </nav>

        <p className="mb-1.5 mt-5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Mail
        </p>
        <nav className="space-y-0.5" aria-label="Mail">
          <NavLink
            label="All"
            icon={InboxIcon}
            active={currentSurface === "mail" && currentView === "all"}
            href="/mail?view=all"
            count={sidebarCounts?.views.all}
          />
          {mailItems.map((item) => (
            <NavLink
              key={item.label}
              label={item.label}
              icon={item.icon}
              active={currentSurface === "mail" && currentView === item.view}
              href={`/mail?view=${item.view}`}
              count={sidebarCounts?.views[item.view]}
            />
          ))}
        </nav>

        {!sidebarCounts ? (
          <p className="mt-3 hidden px-2.5 text-[11px] text-sidebar-foreground/45 lg:block" role="status">
            Mailbox counts are unavailable.
          </p>
        ) : null}

        <p className="mb-1.5 mt-5 hidden px-2.5 text-xs font-medium text-sidebar-foreground/35 lg:block">
          Inboxes
        </p>
        <nav className="space-y-0.5" aria-label="Connected inboxes">
          <div className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70">
            <Avatar size="sm" className="size-5 border-0 after:border-0">
              {connectedAccountImage ? (
                <AvatarImage src={connectedAccountImage} alt="" />
              ) : null}
              <AvatarFallback className="bg-sidebar-accent text-[9px] font-semibold text-sidebar-foreground">
                {initials(account.email)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden min-w-0 flex-1 truncate lg:block">
              {account.email}
            </span>
            <HugeiconsIcon
              icon={Tick02Icon}
              size={14}
              strokeWidth={1.8}
              className="hidden shrink-0 text-sidebar-foreground/65 lg:block"
            />
          </div>
          <form action="/v1/connections/gmail/start" method="get">
            <button
              type="submit"
              aria-label="Add Gmail account"
              className={cn(
                navItemClassName(false),
                "h-8 gap-2 px-2 text-[13px] font-normal",
              )}
            >
              <HugeiconsIcon
                icon={PlusSignIcon}
                size={15}
                strokeWidth={1.65}
                className="shrink-0"
              />
              <span className="hidden truncate lg:block">Add account</span>
            </button>
          </form>
        </nav>
      </div>
    </aside>
  );
}
