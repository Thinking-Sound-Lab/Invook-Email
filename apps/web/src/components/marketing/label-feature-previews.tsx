import { ArrowDown01Icon, Tag01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { PreviewLabelName } from "./preview-mailbox";
import { PreviewLabelChip, PreviewStage, PreviewSurface } from "./preview-primitives";

const builtInLabels = [
  { label: "Important", description: "Messages that need your attention, a decision, or a reply." },
  { label: "Newsletter", description: "Digests, product updates, and other bulk publications." },
  { label: "Billing", description: "Invoices, receipts, charges, and statements." },
  { label: "Others", description: "Everything that doesn’t match another label." },
] as const satisfies ReadonlyArray<{ label: PreviewLabelName; description: string }>;

const sampleMatches = [
  { sender: "Daniel Okafor", subject: "Homepage feedback, round two" },
  { sender: "Lena Fischer", subject: "Brand guidelines, final files" },
  { sender: "Arjun Mehta", subject: "Kickoff agenda for Monday" },
  { sender: "Daniel Okafor", subject: "Approved: launch timeline" },
] as const;

const manageableLabels = ["Important", "Clients", "Newsletter", "Billing", "Others"] as const;

interface LabelPreviewFrameProps {
  label: string;
  tone: "dusk" | "sky" | "meadow";
  children: ReactNode;
}

function LabelPreviewFrame({ label, tone, children }: LabelPreviewFrameProps) {
  return (
    <PreviewStage
      tone={tone}
      label={label}
      className="grid min-h-[26rem] place-items-center p-4 sm:min-h-[30rem] sm:p-10"
    >
      <PreviewSurface className="w-full max-w-md p-5 sm:p-6">{children}</PreviewSurface>
    </PreviewStage>
  );
}

function PreviewFieldLabel({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium">{children}</p>;
}

function PreviewPrimaryButton({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center justify-center bg-primary px-3 text-xs font-medium text-primary-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function BuiltInLabelsPreview() {
  return (
    <LabelPreviewFrame
      tone="dusk"
      label="The four built-in labels: Important, Newsletter, Billing, and Others."
    >
      <p className="text-xl font-semibold tracking-[-0.025em]">Labels</p>
      <ul className="mt-5 space-y-2">
        {builtInLabels.map((item) => (
          <li key={item.label} className="rounded-lg bg-card px-3.5 py-3">
            <PreviewLabelChip label={item.label} />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.description}</p>
          </li>
        ))}
      </ul>
    </LabelPreviewFrame>
  );
}

export function CustomLabelPreview() {
  return (
    <LabelPreviewFrame
      tone="sky"
      label="Creating a custom label named Clients with a plain-language description."
    >
      <p className="text-xl font-semibold tracking-[-0.025em]">Create custom label</p>
      <div className="mt-6 space-y-2">
        <PreviewFieldLabel>Label name</PreviewFieldLabel>
        <p className="flex h-9 items-center bg-input/30 px-3 text-sm ring-1 ring-border">Clients</p>
      </div>
      <div className="mt-5 space-y-2">
        <PreviewFieldLabel>Description</PreviewFieldLabel>
        <p className="min-h-28 bg-input/30 px-3 py-2.5 text-sm leading-6 ring-1 ring-border">
          Messages from current clients about active projects, feedback, approvals, or scheduling.
        </p>
        <p className="text-[11px] leading-5 text-muted-foreground">
          Be specific about the sender, topic, or intent that should match.
        </p>
      </div>
      <PreviewPrimaryButton className="mt-6 w-full">Continue</PreviewPrimaryButton>
    </LabelPreviewFrame>
  );
}

export function SampleMatchesPreview() {
  return (
    <LabelPreviewFrame
      tone="meadow"
      label="Sample matching threads for the Clients label, found before the label is saved."
    >
      <p className="text-xl font-semibold tracking-[-0.025em]">Sample matching threads</p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Found 4 matches in your 100 most recent Inbox threads.
      </p>
      <ul className="mt-5 space-y-1.5">
        {sampleMatches.map((match) => (
          <li key={match.subject} className="rounded-lg bg-card px-3.5 py-2.5">
            <p className="truncate text-xs font-semibold">{match.sender}</p>
            <p className="truncate text-xs text-muted-foreground">{match.subject}</p>
          </li>
        ))}
      </ul>
    </LabelPreviewFrame>
  );
}

export function PastMailPreview() {
  return (
    <LabelPreviewFrame
      tone="dusk"
      label="Confirming the Clients label and applying it to the last 30 days of email."
    >
      <p className="text-base font-semibold">Create “Clients”?</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        New messages will be labeled automatically after ingestion analysis.
      </p>
      <div className="mt-5 flex items-center gap-3 rounded-lg bg-muted px-3 py-2.5">
        <span className="grid size-4 shrink-0 place-items-center rounded-sm bg-primary text-primary-foreground">
          <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.2} />
        </span>
        <span className="flex-1 text-sm font-medium">Also apply to past emails</span>
        <span className="flex h-8 items-center gap-1.5 rounded-md bg-background px-2 text-xs ring-1 ring-border">
          Last 30 days
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="text-muted-foreground" />
        </span>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <span className="inline-flex h-8 items-center px-3 text-xs font-medium text-muted-foreground">
          Back
        </span>
        <PreviewPrimaryButton>Create label</PreviewPrimaryButton>
      </div>
    </LabelPreviewFrame>
  );
}

export function LabelControlPreview() {
  return (
    <LabelPreviewFrame
      tone="sky"
      label="Changing a thread's label from the Manage labels menu."
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-[-0.02em]">
            Homepage feedback, round two
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">Daniel Okafor</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground">
            Clients
          </span>
          <span className="grid size-7 place-items-center bg-muted text-muted-foreground">
            <HugeiconsIcon icon={Tag01Icon} size={15} />
          </span>
        </div>
      </div>
      <div className="ml-auto mt-3 w-full max-w-60 rounded-xl bg-popover p-2.5 shadow-xl ring-1 ring-border/55">
        <p className="px-2 pb-1.5 text-xs font-semibold">Manage labels</p>
        <ul className="space-y-0.5">
          {manageableLabels.map((label) => (
            <li
              key={label}
              className={cn(
                "flex h-7 items-center gap-2 px-2 text-xs",
                label === "Clients" && "bg-muted",
              )}
            >
              <span className="flex size-4 items-center justify-center">
                {label === "Clients" ? <HugeiconsIcon icon={Tick02Icon} size={13} /> : null}
              </span>
              {label}
            </li>
          ))}
        </ul>
      </div>
    </LabelPreviewFrame>
  );
}
