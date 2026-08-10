import {
  ArrowUpRight01Icon,
  Attachment01Icon,
  BotIcon,
  PencilEdit01Icon,
  Search02Icon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { formatMailText } from "./mail-format";

const suggestions = [
  { label: "Handle what needs my attention", icon: BotIcon },
  { label: "Find a message or decision", icon: Search02Icon },
  { label: "Draft a follow-up", icon: PencilEdit01Icon },
  { label: "Automate repeated inbox work", icon: WorkflowSquare01Icon },
] as const;

export function AgentPanel({
  openThreadSubject,
  aiConfigured,
}: {
  openThreadSubject?: string;
  aiConfigured: boolean;
}) {
  return (
    <aside
      className="hidden min-h-0 flex-col border-l border-border/45 bg-card xl:flex"
      aria-label="Invook agent"
    >
      <header className="flex h-15 shrink-0 items-center justify-between border-b border-border/45 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <HugeiconsIcon icon={BotIcon} size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
          <h2 className="truncate text-[15px] font-semibold">Invook</h2>
        </div>
        <Button variant="ghost" size="icon-sm" disabled aria-label="Start a new chat" className="text-muted-foreground">
          <HugeiconsIcon icon={PencilEdit01Icon} size={15} />
        </Button>
      </header>

      {openThreadSubject ? (
        <div className="bg-background/25 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Current thread</p>
          <p className="mt-1 truncate text-[13px] text-foreground/82">
            {formatMailText(openThreadSubject)}
          </p>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col justify-end px-4 pb-4">
        <div className="space-y-1">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              disabled
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-[13px] text-foreground/76 transition-colors hover:bg-accent disabled:opacity-100"
            >
              <HugeiconsIcon icon={suggestion.icon} size={14} strokeWidth={1.65} className="text-muted-foreground" />
              <span>{suggestion.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 p-3 pt-0">
        <div className="rounded-xl border border-border/65 bg-background/72 p-2 shadow-xl shadow-black/15">
          <Textarea
            disabled
            aria-label="Message Invook agent"
            placeholder={aiConfigured ? "Ask Invook to handle your mail" : "Connect an AI model to chat"}
            className="min-h-20 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
            value=""
            readOnly
          />
          <div className="flex items-center justify-between pt-1">
            <Button variant="ghost" size="sm" disabled className="text-xs text-muted-foreground" aria-label="Attach context">
              <HugeiconsIcon icon={Attachment01Icon} size={14} />
              Attach
            </Button>
            <Button size="icon-sm" disabled aria-label="Send message" className="rounded-full">
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
