import { Download01Icon, StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { PreviewStage, PreviewSurface } from "./preview-primitives";
import { SectionHeading } from "./section-heading";

interface CapabilityCardProps {
  kicker: string;
  title: string;
  description: string;
  previewLabel: string;
  tone: "dusk" | "sky" | "meadow";
  children: ReactNode;
}

function CapabilityCard({ kicker, title, description, previewLabel, tone, children }: CapabilityCardProps) {
  return (
    <article className="flex flex-col rounded-3xl bg-lp-surface p-3">
      <PreviewStage tone={tone} label={previewLabel} className="grid h-60 place-items-center rounded-2xl px-6">
        {children}
      </PreviewStage>
      <div className="px-4 pb-5 pt-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-lp-muted">{kicker}</p>
        <h3 className="mt-2.5 text-xl font-semibold tracking-[-0.03em] text-lp-ink">{title}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-lp-muted">{description}</p>
      </div>
    </article>
  );
}

function MiniRow({ title, detail, isUnread = false }: { title: string; detail: string; isUnread?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2.5", isUnread ? "bg-card" : "bg-card/45")}>
      <span className={cn("size-1.5 shrink-0 rounded-full", isUnread ? "bg-primary-blue" : "bg-transparent")} />
      <div className="min-w-0">
        <p className={cn("truncate text-xs", isUnread ? "font-semibold" : "text-foreground/76")}>{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function SearchPreview() {
  return (
    <PreviewSurface className="w-full max-w-sm p-4">
      <div className="flex gap-2">
        <span className="flex h-9 min-w-0 flex-1 items-center bg-input/30 px-3 text-sm ring-1 ring-border">
          pricing table
        </span>
        <span className="inline-flex h-9 items-center bg-primary px-4 text-xs font-medium text-primary-foreground">
          Search
        </span>
      </div>
      <div className="mt-3 space-y-1.5">
        <MiniRow title="Homepage feedback, round two" detail="Daniel Okafor · maya@studio.example" />
        <MiniRow title="pricing-table-v3.pdf" detail="Attachment · Lena Fischer" />
      </div>
    </PreviewSurface>
  );
}

function LiveSyncPreview() {
  return (
    <PreviewSurface className="w-full max-w-sm space-y-1.5 p-4">
      <div className="rounded-lg ring-1 ring-primary/50">
        <MiniRow title="Arjun Mehta" detail="Kickoff agenda for Monday" isUnread />
      </div>
      <MiniRow title="Priya Raman" detail="Contract redlines before Thursday" />
      <MiniRow title="Daniel Okafor" detail="Homepage feedback, round two" />
    </PreviewSurface>
  );
}

function GmailSourcePreview() {
  return (
    <PreviewSurface className="w-full max-w-sm p-4">
      <div className="flex items-center gap-2.5 rounded-lg bg-card px-3 py-2.5">
        <HugeiconsIcon icon={StarIcon} size={14} className="shrink-0 text-warning" fill="currentColor" />
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">Contract redlines before Thursday</p>
          <p className="truncate text-[11px] text-muted-foreground">Priya Raman</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex h-8 items-center rounded-lg bg-compose-accent px-3.5 text-sm text-compose-accent-foreground">
          Sent with Gmail
        </span>
      </div>
    </PreviewSurface>
  );
}

function AttachmentsPreview() {
  return (
    <PreviewSurface className="flex w-full max-w-sm flex-wrap gap-2 p-4">
      {["brand-guidelines.pdf", "logo-files.zip", "pricing-table-v3.pdf"].map((filename) => (
        <span
          key={filename}
          className="inline-flex h-7 max-w-full items-center gap-1.5 bg-secondary px-2.5 text-xs font-medium text-secondary-foreground"
        >
          <HugeiconsIcon icon={Download01Icon} size={14} className="shrink-0" />
          <span className="truncate">{filename}</span>
        </span>
      ))}
    </PreviewSurface>
  );
}

export function CapabilitiesSection() {
  return (
    <section className="marketing-reveal mx-auto max-w-7xl px-6 pt-28 sm:pt-36">
      <SectionHeading
        title="In step with Gmail"
        description="Gmail keeps your messages, read state, stars, and drafts. Invook keeps up and gets out of the way."
      />
      <div className="mt-14 grid gap-4 md:grid-cols-2">
        <CapabilityCard
          kicker="Search"
          title="Find any conversation"
          description="Search message text, senders, recipients, and attachment filenames across every connected account."
          previewLabel="A search for pricing table matching a message and an attachment filename."
          tone="sky"
        >
          <SearchPreview />
        </CapabilityCard>
        <CapabilityCard
          kicker="Live sync"
          title="New mail shows up on its own"
          description="Gmail push notifications keep Invook current, and open tabs update without a refresh."
          previewLabel="A newly arrived thread appearing at the top of the list."
          tone="dusk"
        >
          <LiveSyncPreview />
        </CapabilityCard>
        <CapabilityCard
          kicker="Gmail first"
          title="Gmail stays the source of truth"
          description="Stars, read state, and sent mail are written to Gmail first, then reflected in Invook."
          previewLabel="A starred thread and a reply that was sent with Gmail."
          tone="meadow"
        >
          <GmailSourcePreview />
        </CapabilityCard>
        <CapabilityCard
          kicker="Attachments"
          title="Files, right in the thread"
          description="Download attachments from any message, checked for size and integrity before they reach you."
          previewLabel="Three attachments ready to download from a message."
          tone="sky"
        >
          <AttachmentsPreview />
        </CapabilityCard>
      </div>
    </section>
  );
}
