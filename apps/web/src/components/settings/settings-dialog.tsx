"use client";

import {
  Brain02Icon,
  CreditCardIcon,
  Settings01Icon,
  TagsIcon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  MailboxAccount,
  MailLabel,
  MemoryEntry,
} from "@invook/contracts";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAccountSyncStore } from "@/stores/account-sync/store";

import { LabelSettings } from "./label-settings";
import { MemorySettings } from "./memory-settings";

const settingsSections = [
  { value: "account", label: "Account", icon: UserAccountIcon },
  { value: "memory", label: "Memory", icon: Brain02Icon },
  { value: "labels", label: "Labels", icon: TagsIcon },
  { value: "billing", label: "Billing", icon: CreditCardIcon },
] as const;

interface AccountSettingsProps {
  account: MailboxAccount;
  aiConfigured: boolean;
}

function AccountSettings({ account, aiConfigured }: AccountSettingsProps) {
  const replicaStatus = account.replica.state.replaceAll("_", " ");

  return (
    <section className="mx-auto w-full max-w-2xl px-6 py-8 sm:px-10 sm:py-10">
      <h2 className="text-xl font-semibold tracking-[-0.03em]">Account</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        Manage the Google account and local Invook session used by this mailbox.
      </p>

      <div className="mt-7 rounded-xl bg-card/65 p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-sm font-semibold">
            {account.email.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{account.email}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Google Gmail</p>
          </div>
        </div>

        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-background/55 px-4 py-3">
            <dt className="text-xs text-muted-foreground">Connection</dt>
            <dd className="mt-1 font-medium capitalize">{account.status}</dd>
          </div>
          <div className="rounded-lg bg-background/55 px-4 py-3">
            <dt className="text-xs text-muted-foreground">Mailbox replica</dt>
            <dd className="mt-1 font-medium capitalize">{replicaStatus}</dd>
          </div>
          <div className="rounded-lg bg-background/55 px-4 py-3 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">AI features</dt>
            <dd className="mt-1 font-medium">
              {aiConfigured ? "Configured" : "Setup needed"}
            </dd>
          </div>
        </dl>
      </div>

      <form action="/v1/auth/sign-out" method="post" className="mt-6">
        <Button type="submit" variant="secondary">
          Sign out of Invook
        </Button>
      </form>
    </section>
  );
}

function BillingSettings() {
  return (
    <section className="mx-auto w-full max-w-2xl px-6 py-8 sm:px-10 sm:py-10">
      <h2 className="text-xl font-semibold tracking-[-0.03em]">Billing</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        Review the billing state attached to this Invook installation.
      </p>

      <div className="mt-7 rounded-xl bg-card/65 px-6 py-10 text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-secondary text-muted-foreground">
          <HugeiconsIcon icon={CreditCardIcon} size={18} />
        </span>
        <p className="mt-4 text-sm font-semibold">Billing details are unavailable</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
          This build does not expose a billing provider or plan status yet.
        </p>
      </div>
    </section>
  );
}

export interface SettingsDialogProps {
  account: MailboxAccount;
  memories: MemoryEntry[];
  labels: MailLabel[];
  aiConfigured: boolean;
  batchConfigured: boolean;
  triggerClassName?: string;
}

export function SettingsDialog({
  account,
  memories,
  labels,
  aiConfigured,
  batchConfigured,
  triggerClassName,
}: SettingsDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const liveMemoryState = useAccountSyncStore(
    (state) => state.progress?.memory,
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            triggerClassName,
            isOpen && "bg-sidebar-accent text-sidebar-foreground",
          )}
        >
          <HugeiconsIcon
            icon={Settings01Icon}
            size={15}
            strokeWidth={1.65}
            className="shrink-0"
          />
          <span className="hidden truncate lg:block">Settings</span>
        </button>
      </DialogTrigger>
      <DialogContent className="h-[min(760px,calc(100dvh-2rem))] max-w-[min(1040px,calc(100%-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(1040px,calc(100%-2rem))]">
        <DialogHeader className="px-6 py-5 pr-14">
          <DialogTitle className="text-lg font-semibold tracking-[-0.025em]">
            Settings
          </DialogTitle>
          <DialogDescription>
            Manage your account, Memory, labels, and billing in one place.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="account"
          orientation="vertical"
          className="grid min-h-0 grid-cols-[64px_minmax(0,1fr)] gap-0 bg-background sm:grid-cols-[180px_minmax(0,1fr)]"
        >
          <TabsList
            variant="line"
            aria-label="Settings sections"
            className="h-full w-full items-stretch justify-start gap-1 rounded-none bg-muted/35 p-3"
          >
            {settingsSections.map((section) => (
              <TabsTrigger
                key={section.value}
                value={section.value}
                className="h-10 w-full flex-none justify-start gap-2.5 px-3 text-[13px] after:inset-y-2 after:right-auto after:-left-3 after:h-auto after:w-0.5"
                aria-label={section.label}
              >
                <HugeiconsIcon icon={section.icon} size={15} />
                <span className="hidden sm:inline">{section.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="account" className="min-h-0 overflow-y-auto">
            <AccountSettings account={account} aiConfigured={aiConfigured} />
          </TabsContent>
          <TabsContent value="memory" className="min-h-0 overflow-y-auto">
            <MemorySettings
              memories={memories}
              syncState={liveMemoryState ?? account.syncState.memory}
              aiConfigured={aiConfigured}
            />
          </TabsContent>
          <TabsContent value="labels" className="min-h-0 overflow-y-auto">
            <LabelSettings labels={labels} batchConfigured={batchConfigured} />
          </TabsContent>
          <TabsContent value="billing" className="min-h-0 overflow-y-auto">
            <BillingSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
