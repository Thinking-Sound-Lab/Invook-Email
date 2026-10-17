import {
  Mail01Icon,
  MailAccount01Icon,
  PlusSignIcon,
  SentIcon,
  Tick02Icon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { PREVIEW_ACCOUNTS, type PreviewAccountKey } from "./preview-mailbox";
import { PreviewAccountAvatar, PreviewStage, PreviewSurface } from "./preview-primitives";
import { SectionHeading } from "./section-heading";

const accountPoints = [
  {
    icon: UserMultipleIcon,
    title: "Browse them together",
    description: "Connect several Gmail accounts and read every Inbox in one list.",
  },
  {
    icon: MailAccount01Icon,
    title: "Focus on one inbox",
    description: "Switch to a single account when you want to work through just that mail.",
  },
  {
    icon: SentIcon,
    title: "Send from the right address",
    description: "Choose which connected account a new message is sent from.",
  },
] as const;

const accountKeys = Object.keys(PREVIEW_ACCOUNTS) as PreviewAccountKey[];

function AccountsPreview() {
  return (
    <PreviewStage
      tone="sky"
      label="The Inboxes list with two Gmail accounts, next to a new message being sent from the work account."
      className="p-5 sm:p-10"
    >
      <PreviewSurface className="grid sm:grid-cols-[200px_minmax(0,1fr)]">
        <div className="bg-sidebar px-3 py-4">
          <p className="mb-1.5 px-2.5 text-xs font-medium text-sidebar-foreground/35">Inboxes</p>
          <div className="space-y-0.5">
            <div className="flex h-8 items-center gap-2 rounded-md bg-sidebar-accent px-2 text-[13px] font-medium text-sidebar-foreground">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-sidebar-accent">
                <HugeiconsIcon icon={Mail01Icon} size={12} strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1 truncate">All</span>
              <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.8} className="shrink-0 text-sidebar-foreground/65" />
            </div>
            {accountKeys.map((account) => (
              <div
                key={account}
                className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-sidebar-foreground/58"
              >
                <PreviewAccountAvatar account={account} className="ring-offset-sidebar" />
                <span className="min-w-0 flex-1 truncate">{PREVIEW_ACCOUNTS[account].email}</span>
              </div>
            ))}
            <div className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground/58">
              <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={1.65} className="shrink-0" />
              <span className="truncate">Add account</span>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col bg-background">
          <div className="bg-muted/55 py-1">
            <div className="flex min-h-11 items-center gap-3 px-5">
              <span className="w-11 shrink-0 text-xs font-medium text-muted-foreground">From</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {PREVIEW_ACCOUNTS.work.email}
              </span>
            </div>
            <div className="flex min-h-11 items-center gap-3 px-5">
              <span className="w-11 shrink-0 text-xs font-medium text-muted-foreground">To</span>
              <span className="min-w-0 flex-1 truncate text-sm">daniel@northwind.example</span>
            </div>
          </div>
          <div className="flex min-h-11 items-center px-5 text-sm font-medium">
            Re: Homepage feedback, round two
          </div>
          <p className="flex-1 px-5 pb-6 text-sm leading-6 text-foreground/80">
            Thanks for the notes, Daniel. I’ll send the updated pricing table this afternoon.
          </p>
          <div className="px-5 pb-5">
            <span className="inline-flex h-8 items-center rounded-lg bg-compose-accent px-3.5 text-sm text-compose-accent-foreground">
              Send
            </span>
          </div>
        </div>
      </PreviewSurface>
    </PreviewStage>
  );
}

export function AccountsSection() {
  return (
    <section id="accounts" className="marketing-reveal mx-auto max-w-7xl px-6 pt-28 sm:pt-36">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <AccountsPreview />
        <div>
          <SectionHeading
            align="start"
            title="Every account, one workspace"
            description="Keep work and personal Gmail side by side without signing in and out."
          />
          <ul className="mt-10 space-y-7">
            {accountPoints.map((point) => (
              <li key={point.title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lp-surface text-lp-ink">
                  <HugeiconsIcon icon={point.icon} size={18} strokeWidth={1.7} />
                </span>
                <div>
                  <p className="text-base font-semibold tracking-[-0.02em] text-lp-ink">{point.title}</p>
                  <p className="mt-1 text-sm leading-6 text-lp-muted">{point.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
