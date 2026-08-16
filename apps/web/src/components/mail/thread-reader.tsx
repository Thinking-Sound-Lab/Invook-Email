import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowLeft02Icon,
  Download01Icon,
  MailReply01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvookLabel } from "@invook/contracts";
import Link from "next/link";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  displayName,
  formatMailBody,
  formatMailText,
  formatRecipientDetails,
  formatRecipientSummary,
  initials,
} from "./mail-format";
import { DraftComposer } from "./draft-composer";
import { buildEmailHtmlDocument } from "./email-html-document";
import { EmailHtmlFrame } from "./email-html-frame";
import { LocalMailDate } from "./local-mail-date";
import { MessageStarButton } from "./message-star-button";
import { SmartLabelControls } from "./smart-label-controls";
import type { MailboxView, SelectedThread } from "./types";

export interface ThreadReaderProps {
  thread: SelectedThread;
  currentView: MailboxView;
  mailboxCursor?: string;
  accountEmail: string;
  aiConfigured: boolean;
  availableLabels: InvookLabel[];
}

export function ThreadReader({
  thread,
  currentView,
  mailboxCursor,
  accountEmail,
  aiConfigured,
  availableLabels,
}: ThreadReaderProps) {
  const mailboxQuery = new URLSearchParams({ view: currentView });
  if (mailboxCursor) mailboxQuery.set("cursor", mailboxCursor);
  const failedMessageCount = thread.messages.filter(
    (message) => message.labelAnalysisState === "failed",
  ).length;
  const hasLabelAnalysisFailure =
    thread.hasLabelAnalysisFailure || failedMessageCount > 0;
  const latestMessage = thread.messages.at(-1);
  const isLatestMessageStarred = Boolean(
    latestMessage?.gmailLabels.some(
      (label) => label.providerLabelId === "STARRED",
    ),
  );

  return (
    <section
      className="flex min-h-0 flex-col bg-background"
      aria-label="Open email thread"
    >
      <header className="relative z-30 flex min-h-15 shrink-0 items-center justify-between gap-3 border-b border-border/35 px-3 sm:px-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="text-sm text-muted-foreground"
        >
          <Link href={`/mail?${mailboxQuery.toString()}`} scroll={false}>
            <HugeiconsIcon icon={ArrowLeft02Icon} size={16} />
            Back
          </Link>
        </Button>
        <div className="flex min-w-0 items-center justify-end gap-1">
          <SmartLabelControls
            key={thread.id}
            threadId={thread.id}
            labels={thread.invookLabels}
            availableLabels={availableLabels}
            isOthers={thread.isOthers}
          />
          {latestMessage ? (
            <MessageStarButton
              messageId={latestMessage.id}
              isStarred={isLatestMessageStarred}
            />
          ) : null}
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[900px] px-5 py-7 sm:px-8 sm:py-9 lg:px-10">
          <h1 className="text-balance text-xl font-semibold leading-7 tracking-[-0.025em] sm:text-[22px] sm:leading-8">
            {formatMailText(thread.subject) || "(No subject)"}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
          </p>

          {hasLabelAnalysisFailure ? (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2.5 rounded-lg bg-warning/10 px-3 py-2.5 text-sm"
            >
              <HugeiconsIcon
                icon={AlertCircleIcon}
                size={16}
                className="mt-0.5 shrink-0 text-warning"
              />
              <p className="leading-5 text-foreground/80">
                Automatic label analysis failed
                {failedMessageCount > 1
                  ? ` for ${failedMessageCount} messages`
                  : " for a message"}
                . The stored content remains available, but its Invook labels may be
                incomplete.
              </p>
            </div>
          ) : null}

          <div className="mt-7 space-y-14">
            {thread.messages.map((message) => {
              const senderName = displayName(
                message.sender.raw || message.sender.email,
              );
              const senderLabel =
                message.direction === "outgoing" ? "You" : senderName;
              const emailHtmlDocument = message.bodyHtml
                ? buildEmailHtmlDocument(message.bodyHtml, message.id)
                : null;
              return (
                <article
                  key={message.id}
                  aria-labelledby={`message-${message.id}-sender`}
                >
                  <div className="flex items-start gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback className="bg-secondary text-[11px] font-semibold">
                        {initials(senderName)}
                      </AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p
                            id={`message-${message.id}-sender`}
                            className="truncate text-sm font-semibold leading-5"
                          >
                            {senderLabel}
                          </p>
                          <details className="group relative min-w-0">
                            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                              <span className="truncate">
                                To: {formatRecipientSummary(message.recipients, accountEmail)}
                              </span>
                              <HugeiconsIcon
                                icon={ArrowDown01Icon}
                                size={11}
                                className="shrink-0 transition-transform group-open:rotate-180"
                              />
                            </summary>
                            <div className="absolute left-0 top-full z-20 mt-2 w-[min(32rem,calc(100vw-3rem))] rounded-lg bg-popover p-3 text-xs shadow-xl ring-1 ring-border/55">
                              <dl className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2 gap-y-2 leading-5">
                                <dt className="text-muted-foreground">From</dt>
                                <dd className="break-words">
                                  {formatMailText(
                                    message.sender.raw || message.sender.email,
                                  )}
                                </dd>
                                <dt className="text-muted-foreground">To</dt>
                                <dd className="break-words">
                                  {formatRecipientDetails(
                                    message.recipients,
                                    accountEmail,
                                  )}
                                </dd>
                              </dl>
                            </div>
                          </details>
                        </div>

                        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                          <Button
                            asChild
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                          >
                            <a href="#reply-draft" aria-label="Reply to this thread">
                              <HugeiconsIcon icon={MailReply01Icon} size={14} />
                            </a>
                          </Button>
                          <LocalMailDate
                            className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground sm:text-xs"
                            value={message.sentAt}
                          />
                        </div>
                      </div>

                      {emailHtmlDocument ? (
                        <div className="mt-7 flex justify-center">
                          <EmailHtmlFrame
                            className="max-w-[720px]"
                            document={emailHtmlDocument}
                            frameId={message.id}
                          />
                        </div>
                      ) : (
                        <div className="mx-auto mt-7 max-w-[720px] whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground/88">
                          {formatMailBody(message.bodyText) ||
                            "This email has no readable body."}
                        </div>
                      )}

                      {message.attachments.length > 0 ? (
                        <div
                          className="mx-auto mt-5 flex max-w-[720px] flex-wrap gap-2"
                          aria-label="Attachments"
                        >
                          {message.attachments.map((attachment) => (
                            <Button
                              key={attachment.id}
                              asChild
                              variant="secondary"
                              size="sm"
                              className="max-w-full"
                            >
                              <a
                                href={`/v1/attachments/${encodeURIComponent(attachment.id)}/download`}
                                download
                              >
                                <HugeiconsIcon icon={Download01Icon} size={15} />
                                <span className="truncate">
                                  {formatMailText(attachment.filename) || "Attachment"}
                                </span>
                              </a>
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          <div id="reply-draft" className="scroll-mt-6">
            <DraftComposer
              key={thread.id}
              threadId={thread.id}
              initialDraft={thread.aiReplyDraft}
              aiConfigured={aiConfigured}
            />
          </div>
        </div>
      </ScrollArea>
    </section>
  );
}
