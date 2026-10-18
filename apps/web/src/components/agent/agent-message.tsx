"use client";

import {
  Alert02Icon,
  Attachment01Icon,
  CheckmarkCircle02Icon,
  FileEditIcon,
  Mail01Icon,
  Search02Icon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  AgentApprovalDecision,
  AgentEmailInput,
  InvookAgentUIMessage,
} from "@invook/contracts";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  useForwardedMessageText,
  type ForwardedMessageText,
} from "@/hooks/use-forwarded-message-text";
import { LocalMailDate } from "@/components/mail/local-mail-date";
import { MailboxLink } from "@/components/mail/mailbox-link";
import { useMailShell } from "@/components/mail/mail-shell-provider";
import { cn } from "@/lib/utils";

type AgentMessagePart = InvookAgentUIMessage["parts"][number];
type ToolPart<Name extends string> = Extract<AgentMessagePart, { type: `tool-${Name}` }>;
type Icon = typeof Mail01Icon;

export interface AgentMessageProps {
  message: InvookAgentUIMessage;
  accountSelection: string;
  canDecide: boolean;
  onDecide: (decision: AgentApprovalDecision) => void;
  /** Whether this message ends an interrupted turn that can be retried. */
  canRetry: boolean;
  onRetry: () => void;
}

export function AgentMessage({
  message,
  accountSelection,
  canDecide,
  onDecide,
  canRetry,
  onRetry,
}: AgentMessageProps) {
  if (message.role === "user") {
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-secondary px-3.5 py-2 text-[13px] leading-5 text-secondary-foreground">
          {text}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      {message.parts.map((part, index) => (
        <AgentMessagePartView
          key={"toolCallId" in part ? part.toolCallId : `${part.type}-${index}`}
          part={part}
          accountSelection={accountSelection}
          canDecide={canDecide}
          onDecide={onDecide}
          canRetry={canRetry}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

interface AgentMessagePartViewProps {
  part: AgentMessagePart;
  accountSelection: string;
  canDecide: boolean;
  onDecide: (decision: AgentApprovalDecision) => void;
  canRetry: boolean;
  onRetry: () => void;
}

function AgentMessagePartView({
  part,
  accountSelection,
  canDecide,
  onDecide,
  canRetry,
  onRetry,
}: AgentMessagePartViewProps) {
  switch (part.type) {
    case "text":
      return part.text ? (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/88">
          {part.text}
        </p>
      ) : null;
    case "tool-searchMail":
      return <SearchMailPart part={part} accountSelection={accountSelection} />;
    case "tool-readThread":
      return <ReadThreadPart part={part} accountSelection={accountSelection} />;
    case "tool-saveDraft":
      return <SaveDraftPart part={part} />;
    case "tool-sendEmail":
      return (
        <SendEmailPart
          part={part}
          canDecide={canDecide}
          onDecide={onDecide}
          canRetry={canRetry}
          onRetry={onRetry}
        />
      );
    default:
      return null;
  }
}

interface StatusLineProps {
  icon: Icon;
  tone?: "muted" | "success" | "destructive";
  children: ReactNode;
}

function StatusLine({ icon, tone = "muted", children }: StatusLineProps) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs leading-5",
        tone === "muted" && "text-muted-foreground",
        tone === "success" && "text-success",
        tone === "destructive" && "text-destructive",
      )}
      role={tone === "destructive" ? "alert" : undefined}
    >
      <HugeiconsIcon icon={icon} size={13} className="mt-1 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function threadHref(accountSelection: string, accountId: string, threadId: string) {
  const params = new URLSearchParams({
    account: accountSelection === "all" ? "all" : accountId,
    thread: threadId,
  });
  return `/mail?${params.toString()}`;
}

function SearchMailPart({
  part,
  accountSelection,
}: {
  part: ToolPart<"searchMail">;
  accountSelection: string;
}) {
  const query = part.input?.query;
  if (part.state === "output-error") {
    return <StatusLine icon={Alert02Icon} tone="destructive">{part.errorText}</StatusLine>;
  }
  if (part.state !== "output-available") {
    return (
      <StatusLine icon={Search02Icon}>
        Searching mail{query ? ` for “${query}”` : ""}…
      </StatusLine>
    );
  }
  const { output } = part;
  if (output.status === "failed") {
    return <StatusLine icon={Alert02Icon} tone="destructive">{output.reason}</StatusLine>;
  }
  return (
    <div className="space-y-1.5">
      <StatusLine icon={Search02Icon}>
        {output.results.length === 0
          ? `No mail matched “${part.input.query}”.`
          : `Found ${output.results.length} ${output.results.length === 1 ? "message" : "messages"} for “${part.input.query}”.`}
      </StatusLine>
      {output.results.length > 0 ? (
        <ul className="space-y-1" aria-label="Search results">
          {output.results.map((result) => (
            <li key={result.messageId}>
              <MailboxLink
                href={threadHref(accountSelection, result.accountId, result.threadId)}
                className="block rounded-lg bg-card/60 px-3 py-2 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-[13px] font-medium">
                    {result.subject || "(No subject)"}
                  </p>
                  <LocalMailDate
                    className="shrink-0 text-[11px] text-muted-foreground"
                    value={result.sentAt}
                  />
                </div>
                <p className="truncate text-xs text-muted-foreground">{result.sender}</p>
                {result.attachmentFilenames.length > 0 ? (
                  <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                    <HugeiconsIcon icon={Attachment01Icon} size={12} className="shrink-0" />
                    <span className="truncate">{result.attachmentFilenames.join(", ")}</span>
                  </p>
                ) : null}
              </MailboxLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ReadThreadPart({
  part,
  accountSelection,
}: {
  part: ToolPart<"readThread">;
  accountSelection: string;
}) {
  if (part.state === "output-error") {
    return <StatusLine icon={Alert02Icon} tone="destructive">{part.errorText}</StatusLine>;
  }
  if (part.state !== "output-available") {
    return <StatusLine icon={Mail01Icon}>Reading the thread…</StatusLine>;
  }
  if (part.output.status === "unavailable") {
    return <StatusLine icon={Alert02Icon}>That thread is not available.</StatusLine>;
  }
  const { thread } = part.output;
  return (
    <StatusLine icon={Mail01Icon}>
      Read{" "}
      <MailboxLink
        href={threadHref(accountSelection, thread.accountId, thread.threadId)}
        className="underline-offset-2 hover:underline"
      >
        “{thread.subject || "(No subject)"}”
      </MailboxLink>
    </StatusLine>
  );
}

function ForwardedMessagePreview({
  forwarded,
  onReload,
}: {
  forwarded: ForwardedMessageText;
  onReload: () => void;
}) {
  if (forwarded.loadState === "none") return null;
  if (forwarded.loadState === "loading") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Loading the forwarded message…
      </p>
    );
  }
  if (forwarded.loadState === "error") {
    return (
      <div role="alert" className="flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-destructive">
          The forwarded message could not be loaded, so it cannot be reviewed here.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 rounded-md"
          onClick={onReload}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Forwarded message, included below the text. Its attachments are not.
      </p>
      <p
        aria-label="Forwarded message"
        className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 px-3 py-2 text-xs leading-5 text-foreground/80"
      >
        {forwarded.text}
      </p>
    </div>
  );
}

function EmailSummary({
  email,
  forwarded,
  onReloadForwarded,
}: {
  email: AgentEmailInput;
  forwarded: ForwardedMessageText;
  onReloadForwarded: () => void;
}) {
  const { accounts } = useMailShell();
  const sender = accounts.find((account) => account.id === email.accountId)?.email;
  const rows: Array<[string, string]> = [
    ["From", sender ?? "Unknown account"],
    ["To", email.to.join(", ")],
    ...(email.cc.length > 0 ? [["Cc", email.cc.join(", ")] as [string, string]] : []),
    ...(email.bcc.length > 0 ? [["Bcc", email.bcc.join(", ")] as [string, string]] : []),
    ["Subject", email.subject || "(No subject)"],
  ];
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {email.body ? (
        <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 px-3 py-2 text-[13px] leading-5">
          {email.body}
        </p>
      ) : null}
      <ForwardedMessagePreview forwarded={forwarded} onReload={onReloadForwarded} />
    </div>
  );
}

/**
 * Shows an email with the forwarded message it would include. `children`
 * receives whether everything that would be sent is on screen, which an
 * approval requires.
 */
function EmailDetails({
  email,
  children,
}: {
  email: AgentEmailInput;
  children?: (isComplete: boolean) => ReactNode;
}) {
  const { forwarded, reload } = useForwardedMessageText({
    accountId: email.accountId,
    messageId: email.forwardOfMessageId,
  });
  return (
    <>
      <EmailSummary email={email} forwarded={forwarded} onReloadForwarded={reload} />
      {children?.(
        forwarded.loadState === "none" || forwarded.loadState === "available",
      )}
    </>
  );
}

function draftsHref(accountId: string): string {
  return `/mail?${new URLSearchParams({ account: accountId, view: "drafts" }).toString()}`;
}

function SaveDraftPart({ part }: { part: ToolPart<"saveDraft"> }) {
  if (part.state === "input-streaming") {
    return <StatusLine icon={FileEditIcon}>Writing a draft…</StatusLine>;
  }
  if (part.state === "output-error") {
    return <StatusLine icon={Alert02Icon} tone="destructive">{part.errorText}</StatusLine>;
  }
  if (part.state === "output-available" && part.output.status === "failed") {
    return (
      <section aria-label="Draft not saved" className="space-y-2.5 rounded-xl bg-card/60 px-3.5 py-3">
        <StatusLine icon={Alert02Icon} tone="destructive">
          Draft not saved. {part.output.reason}
        </StatusLine>
        <EmailDetails email={part.input} />
      </section>
    );
  }
  const isSaved = part.state === "output-available";
  return (
    <section
      aria-label={isSaved ? "Saved draft" : "Draft being saved"}
      className="space-y-2.5 rounded-xl bg-card px-3.5 py-3"
    >
      <StatusLine icon={isSaved ? CheckmarkCircle02Icon : FileEditIcon} tone={isSaved ? "success" : "muted"}>
        {isSaved ? "Draft saved in Gmail" : "Saving draft…"}
      </StatusLine>
      <EmailDetails email={part.input} />
      {part.state === "output-available" && part.output.status === "saved" ? (
        <MailboxLink
          href={draftsHref(part.output.accountId)}
          className="inline-block text-xs font-medium underline-offset-2 hover:underline"
        >
          Open Drafts
        </MailboxLink>
      ) : null}
    </section>
  );
}

function SendEmailPart({
  part,
  canDecide,
  onDecide,
  canRetry,
  onRetry,
}: {
  part: ToolPart<"sendEmail">;
  canDecide: boolean;
  onDecide: (decision: AgentApprovalDecision) => void;
  canRetry: boolean;
  onRetry: () => void;
}) {
  if (part.state === "input-streaming") {
    return <StatusLine icon={SentIcon}>Preparing an email…</StatusLine>;
  }
  if (part.state === "output-error") {
    return (
      <section aria-label="Email not confirmed" className="space-y-2.5 rounded-xl bg-card/60 px-3.5 py-3">
        <StatusLine icon={Alert02Icon} tone="destructive">{part.errorText}</StatusLine>
        {part.input ? <EmailDetails email={part.input} /> : null}
      </section>
    );
  }
  if (part.state === "output-denied") {
    return (
      <section aria-label="Email not sent" className="space-y-2.5 rounded-xl bg-card/60 px-3.5 py-3">
        <StatusLine icon={Alert02Icon}>
          {part.approval.reason
            ? `Not sent. ${part.approval.reason}`
            : "You chose not to send this email."}
        </StatusLine>
        <EmailDetails email={part.input} />
      </section>
    );
  }
  if (part.state === "output-available") {
    return part.output.status === "sent" ? (
      <section aria-label="Sent email" className="space-y-2.5 rounded-xl bg-card px-3.5 py-3">
        <StatusLine icon={CheckmarkCircle02Icon} tone="success">Sent</StatusLine>
        <EmailDetails email={part.input} />
      </section>
    ) : (
      <section aria-label="Email not sent" className="space-y-2.5 rounded-xl bg-card/60 px-3.5 py-3">
        <StatusLine icon={Alert02Icon} tone="destructive">
          Not sent. {part.output.reason}
        </StatusLine>
        <EmailDetails email={part.input} />
      </section>
    );
  }
  if (part.state === "approval-responded") {
    // A decision whose turn ended before the tool finished can be resumed:
    // the server repeats the same call, and Gmail writes under its ID are
    // idempotent, so retrying never sends twice.
    const isInterrupted = canDecide;
    return (
      <section aria-label="Email being sent" className="space-y-2.5 rounded-xl bg-card px-3.5 py-3">
        <StatusLine icon={SentIcon}>
          {!isInterrupted
            ? part.approval.approved ? "Sending…" : "Not sending."
            : part.approval.approved
              ? "Sending did not finish."
              : "You declined this email, but the agent did not finish."}
        </StatusLine>
        <EmailDetails email={part.input} />
        {isInterrupted && canRetry ? (
          <Button
            type="button"
            variant="secondary"
            onClick={onRetry}
            className="h-8 rounded-lg text-sm font-normal"
          >
            Retry
          </Button>
        ) : null}
      </section>
    );
  }
  const isRequested = part.state === "approval-requested";
  return (
    <section
      aria-label="Email waiting for your approval"
      className="space-y-2.5 rounded-xl bg-card px-3.5 py-3"
    >
      <StatusLine icon={SentIcon}>
        {isRequested
          ? "Review this email. Nothing is sent until you approve it."
          : "Preparing an email…"}
      </StatusLine>
      <EmailDetails email={part.input}>
        {(isComplete) =>
          isRequested && !part.approval.isAutomatic ? (
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={!canDecide || !isComplete}
                onClick={() => onDecide({ approvalId: part.approval.id, approved: true })}
                className="h-8 rounded-lg bg-compose-accent px-3.5 text-sm font-normal text-compose-accent-foreground hover:bg-compose-accent-hover"
              >
                Send
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!canDecide}
                onClick={() => onDecide({ approvalId: part.approval.id, approved: false })}
                className="h-8 rounded-lg text-sm font-normal"
              >
                Don’t send
              </Button>
            </div>
          ) : null
        }
      </EmailDetails>
    </section>
  );
}
