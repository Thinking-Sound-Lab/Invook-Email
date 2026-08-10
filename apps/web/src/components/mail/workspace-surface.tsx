import {
  ArrowLeft02Icon,
  PencilEdit01Icon,
  Search02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AccountSyncStage, MemoryEntry } from "@invook/contracts";
import Link from "next/link";

import { MemorySettings } from "@/components/settings/memory-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

function SurfaceHeader({ title }: { title: string }) {
  return (
    <header className="flex h-15 shrink-0 items-center gap-2 border-b border-border/45 px-4">
      <Button asChild variant="ghost" size="icon-sm">
        <Link href="/mail" aria-label="Return to mail">
          <HugeiconsIcon icon={ArrowLeft02Icon} size={15} />
        </Link>
      </Button>
      <h1 className="text-[15px] font-semibold tracking-[-0.02em]">{title}</h1>
    </header>
  );
}

export function SearchSurface() {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="Search" />
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-12">
        <span className="grid size-10 place-items-center rounded-xl bg-secondary/55">
          <HugeiconsIcon icon={Search02Icon} size={18} className="text-muted-foreground" />
        </span>
        <h2 className="mt-4 text-xl font-semibold tracking-[-0.03em]">Search indexed Gmail</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          Search uses the real subjects, participants, and message previews already stored by the Gmail worker.
        </p>
        <form action="/mail" method="get" className="mt-5 flex gap-2">
          <input type="hidden" name="surface" value="search" />
          <Input name="q" aria-label="Search indexed Gmail" autoFocus className="h-9" />
          <Button type="submit" className="h-9 px-4">Search</Button>
        </form>
      </div>
    </section>
  );
}

export function ComposeSurface() {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="New message" />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8 sm:px-10">
        <div className="flex items-center gap-3 text-sm">
          <span className="w-14 text-muted-foreground">To</span>
          <Input aria-label="Recipients" className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
        </div>
        <Separator />
        <div className="flex items-center gap-3 text-sm">
          <span className="w-14 text-muted-foreground">Subject</span>
          <Input aria-label="Subject" className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
        </div>
        <Separator />
        <Textarea
          aria-label="Message body"
          className="min-h-64 flex-1 resize-none border-0 bg-transparent px-0 py-6 text-[15px] leading-7 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Gmail draft creation and sending are not connected in this UI slice.
          </p>
          <Button disabled>
            <HugeiconsIcon icon={PencilEdit01Icon} size={14} />
            Send
          </Button>
        </div>
      </div>
    </section>
  );
}

export function SettingsSurface({
  memories,
  syncState,
  aiConfigured,
}: {
  memories: MemoryEntry[];
  syncState: AccountSyncStage;
  aiConfigured: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MemorySettings
          initialMemories={memories}
          syncState={syncState}
          aiConfigured={aiConfigured}
        />
      </div>
    </section>
  );
}

export function PendingSurface() {
  const content = {
    title: "Automations",
    icon: WorkflowSquare01Icon,
    description:
      "Agent automations will appear here only after their triggers, approvals, and audit trail are implemented.",
  };

  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title={content.title} />
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-12 text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-secondary/55">
          <HugeiconsIcon icon={content.icon} size={18} className="text-muted-foreground" />
        </span>
        <h2 className="mt-4 text-lg font-semibold">{content.title} is not connected yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{content.description}</p>
      </div>
    </section>
  );
}
