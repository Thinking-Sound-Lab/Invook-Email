import {
  Attachment01Icon,
  BotIcon,
  CommandIcon,
  PencilEdit01Icon,
  Search02Icon,
  SparklesIcon,
  ArrowUpRight01Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AccountSyncStage, MemoryEntry } from "@invook/contracts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

const agentCapabilities = [
  {
    label: "Find",
    description: "Find messages, decisions, dates, and attachments in indexed mail.",
    icon: Search02Icon,
  },
  {
    label: "Write",
    description: "Draft and rewrite using relevant preferences, contacts, and scheduling memory.",
    icon: PencilEdit01Icon,
  },
  {
    label: "Automate",
    description: "Turn repeated inbox work into reviewed, auditable rules.",
    icon: WorkflowSquare01Icon,
  },
] as const;

export function AgentPanel({
  openThreadSubject,
  memories,
  memorySyncState,
  aiConfigured,
}: {
  openThreadSubject?: string;
  memories: MemoryEntry[];
  memorySyncState: AccountSyncStage;
  aiConfigured: boolean;
}) {
  const memoryStatus =
    !aiConfigured && memorySyncState !== "complete"
      ? "Waiting for an AI model"
      : memorySyncState === "complete"
      ? `Memory ready · ${memories.length} ${memories.length === 1 ? "rule" : "rules"}`
      : memorySyncState === "failed"
        ? "Memory analysis needs attention"
        : "Analyzing sent mail for memory";

  return (
    <aside className="hidden min-h-0 flex-col border-l bg-[oklch(0.175_0.003_84)] xl:flex" aria-label="Invook agent">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md border border-foreground/10 bg-foreground/[0.06]">
            <HugeiconsIcon icon={BotIcon} size={15} strokeWidth={1.7} />
          </span>
          <div>
            <h2 className="text-xs font-semibold">Invook</h2>
            <p className="text-[9px] text-muted-foreground">Find · Write · Automate</p>
          </div>
        </div>
        <Badge variant="outline" className="h-5 border-border px-1.5 text-[9px] text-muted-foreground">
          Agent
        </Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="rounded-xl border border-foreground/10 bg-foreground/[0.035] p-4">
          <span className="grid size-9 place-items-center rounded-lg border border-foreground/10 bg-foreground/[0.04] shadow-lg shadow-black/20">
            <HugeiconsIcon icon={SparklesIcon} size={19} strokeWidth={1.5} />
          </span>
          <h3 className="mt-3 text-sm font-semibold tracking-[-0.02em]">Work with your inbox</h3>
          <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
            Ask Invook to retrieve mail, write for a specific person, or automate repeated work.
          </p>
          <p className="mt-3 text-[9px] font-medium text-foreground/75">{memoryStatus}</p>
          {openThreadSubject ? (
            <div className="mt-4 rounded-lg border bg-background/35 px-3 py-2 text-left">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Current context
              </p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4">{openThreadSubject}</p>
            </div>
          ) : null}
        </div>

        <div className="mt-3 space-y-1.5">
          {agentCapabilities.map((capability) => (
            <div
              key={capability.label}
              className="flex items-start gap-3 rounded-lg border border-transparent px-2.5 py-2.5 hover:border-foreground/[0.06] hover:bg-foreground/[0.025]"
            >
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-foreground/[0.05]">
                <HugeiconsIcon icon={capability.icon} size={14} strokeWidth={1.6} />
              </span>
              <div>
                <p className="text-[11px] font-semibold">{capability.label}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {capability.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 p-3">
        <div className="rounded-xl border border-border bg-background/55 p-2 shadow-2xl shadow-black/25">
          <Textarea
            disabled
            aria-label="Message Invook agent"
            placeholder="Ask about your mail…"
            className="min-h-20 resize-none border-0 bg-transparent px-2 py-1.5 text-xs shadow-none focus-visible:ring-0"
            value=""
            readOnly
          />
          <Separator className="my-1.5 opacity-70" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-xs" disabled aria-label="Attach context">
                <HugeiconsIcon icon={Attachment01Icon} size={13} />
              </Button>
              <span className="flex items-center gap-1 px-1.5 text-[9px] text-muted-foreground">
                <HugeiconsIcon icon={CommandIcon} size={11} />
                Chat actions are the next slice
              </span>
            </div>
            <Button size="icon-xs" disabled aria-label="Send message">
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-center text-[9px] leading-4 text-muted-foreground/70">
          Actions will require review before Invook changes Gmail.
        </p>
      </div>
    </aside>
  );
}
