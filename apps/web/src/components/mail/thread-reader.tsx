import {
  ArrowLeft02Icon,
  Download01Icon,
  MoreHorizontalIcon,
  StarIcon,
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
  formatMessageDate,
  initials,
} from "./mail-format";
import { DraftComposer } from "./draft-composer";
import { buildEmailHtmlDocument } from "./email-html-document";
import { EmailHtmlFrame } from "./email-html-frame";
import { SmartLabelControls } from "./smart-label-controls";
import type { MailboxView, SelectedThread } from "./types";

export interface ThreadReaderProps {
  thread: SelectedThread;
  currentView: MailboxView;
  mailboxCursor?: string;
  aiConfigured: boolean;
  availableLabels: InvookLabel[];
}

export function ThreadReader({
  thread,
  currentView,
  mailboxCursor,
  aiConfigured,
  availableLabels,
}: ThreadReaderProps) {
  const mailboxQuery = new URLSearchParams({ view: currentView });
  if (mailboxCursor) mailboxQuery.set("cursor", mailboxCursor);

  return (
    <section className="flex min-h-0 flex-col bg-background" aria-label="Open email thread">
      <header className="flex h-15 shrink-0 items-center justify-between border-b border-border/45 px-4">
        <Button asChild variant="ghost" size="sm" className="text-sm text-muted-foreground">
          <Link href={`/mail?${mailboxQuery.toString()}`} scroll={false}>
            <HugeiconsIcon icon={ArrowLeft02Icon} size={16} />
            Back
          </Link>
        </Button>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" disabled aria-label="Star thread">
            <HugeiconsIcon icon={StarIcon} size={15} />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled aria-label="More thread actions">
            <HugeiconsIcon icon={MoreHorizontalIcon} size={15} />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10 sm:py-10">
          <p className="text-xs font-medium text-muted-foreground">
            {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"}
          </p>
          <h1 className="mt-2 text-balance text-2xl font-semibold leading-8 tracking-[-0.035em] sm:text-[28px] sm:leading-9">
            {formatMailText(thread.subject) || "(No subject)"}
          </h1>
          <SmartLabelControls
            key={thread.id}
            threadId={thread.id}
            labels={thread.invookLabels}
            availableLabels={availableLabels}
          />

          <div className="mt-10 space-y-10">
            {thread.messages.map((message) => {
              const senderName = displayName(message.sender.raw || message.sender.email);
              return (
                <article key={message.id} aria-labelledby={`message-${message.id}-sender`}>
                  <div className="flex items-start gap-3.5">
                    <Avatar className="size-9 rounded-lg">
                      <AvatarFallback className="rounded-lg bg-secondary text-xs font-semibold">
                        {initials(senderName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <div className="min-w-0">
                          <p id={`message-${message.id}-sender`} className="truncate text-sm font-semibold">
                            {message.direction === "outgoing" ? "You" : senderName}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {message.sender.email}
                          </p>
                        </div>
                        <time className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatMessageDate(message.sentAt)}
                        </time>
                      </div>

                      {message.bodyHtml ? (
                        <div className="mt-5 overflow-hidden rounded-lg bg-white p-5">
                          <EmailHtmlFrame
                            document={buildEmailHtmlDocument(message.bodyHtml, message.id)}
                            frameId={message.id}
                          />
                        </div>
                      ) : (
                        <div className="mt-5 whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground/88">
                          {formatMailBody(message.bodyText) || "This email has no readable body."}
                        </div>
                      )}

                      {message.attachments.length > 0 ? (
                        <div className="mt-5 flex flex-wrap gap-2" aria-label="Attachments">
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

          <DraftComposer
            key={thread.id}
            threadId={thread.id}
            initialDraft={thread.aiReplyDraft}
            aiConfigured={aiConfigured}
          />
        </div>
      </ScrollArea>
    </section>
  );
}
