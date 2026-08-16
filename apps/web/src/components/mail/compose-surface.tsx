"use client";

import {
  CheckmarkCircle02Icon,
  MailAdd01Icon,
  MailSend02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GMAIL_COMPOSE_MAX_BODY_LENGTH,
  GMAIL_COMPOSE_MAX_SUBJECT_LENGTH,
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
} from "@invook/contracts";
import { type FormEvent, useReducer } from "react";
import { v4 as uuidv4 } from "uuid";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  composeDraftReducer,
  createComposeDraftState,
} from "@/components/mail/compose-draft-state";
import { SurfaceHeader } from "@/components/mail/surface-header";
import {
  createGmailComposeDraft,
  sendGmailComposeDraft,
  updateGmailComposeDraft,
} from "@/lib/api/compose-drafts";
import { apiErrorMessage } from "@/lib/http-error";

interface ComposeSurfaceProps {
  gmailAccountId: string;
}

export function ComposeSurface({ gmailAccountId }: ComposeSurfaceProps) {
  const [state, dispatch] = useReducer(
    composeDraftReducer,
    undefined,
    () => createComposeDraftState(uuidv4()),
  );
  const isSaving = state.status === "saving";
  const isSending = state.status === "sending";
  const isSent = state.status === "sent";
  const isReconnectRequired = state.status === "reconnect_required";
  const isLocked = isSaving || isSending || isSent || isReconnectRequired;
  const isCurrentDraftSaved = Boolean(
    state.providerDraft &&
      !["editing", "saving", "error"].includes(state.status),
  );
  const canRequestSend =
    Boolean(state.providerDraft && state.sendIdempotencyKey) &&
    ["saved", "send_error"].includes(state.status);

  function handleEdit(
    field: "recipients" | "subject" | "body",
    value: string,
  ): void {
    dispatch({ type: "edit", field, value, idempotencyKey: uuidv4() });
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validation = validateGmailComposeDraftFields({
      recipients: parseGmailComposeRecipients(state.recipients),
      subject: state.subject,
      body: state.body,
    });
    if (!validation.valid) {
      dispatch({ type: "error", message: validation.error.message });
      return;
    }

    dispatch({ type: "saving" });
    const request = {
      idempotencyKey: state.idempotencyKey,
      ...validation.fields,
    };
    try {
      const result = state.providerDraft
        ? await updateGmailComposeDraft(
            state.providerDraft.providerDraftId,
            request,
          )
        : await createGmailComposeDraft(request);
      dispatch({
        type: "saved",
        draft: result.draft,
        sendIdempotencyKey: uuidv4(),
      });
    } catch (error) {
      const message = apiErrorMessage(
        error,
        "Invook could not save this draft to Gmail.",
      );
      dispatch({
        type: "error",
        message,
        isReconnectRequired: message === "Gmail account must be reconnected",
      });
    }
  }

  async function handleSend(): Promise<void> {
    if (!state.providerDraft || !state.sendIdempotencyKey) return;
    dispatch({ type: "sending" });
    try {
      await sendGmailComposeDraft(state.providerDraft.providerDraftId, {
        idempotencyKey: state.sendIdempotencyKey,
      });
      dispatch({ type: "sent" });
    } catch (error) {
      const message = apiErrorMessage(
        error,
        "Invook could not send this Gmail draft.",
      );
      dispatch({
        type: "send_error",
        message,
        isReconnectRequired: message === "Gmail account must be reconnected",
      });
    }
  }

  return (
    <section className="flex min-h-0 flex-col bg-background">
      <SurfaceHeader title="New message" />
      <form
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8 sm:px-10"
        onSubmit={(event) => void handleSave(event)}
      >
        <div className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-[72px_minmax(0,1fr)] sm:items-center">
            <label htmlFor="compose-recipients" className="text-sm text-muted-foreground">
              To
            </label>
            <Input
              id="compose-recipients"
              value={state.recipients}
              onChange={(event) => handleEdit("recipients", event.target.value)}
              placeholder="person@example.com, teammate@example.com"
              autoComplete="off"
              disabled={isLocked}
              required
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-[72px_minmax(0,1fr)] sm:items-center">
            <label htmlFor="compose-subject" className="text-sm text-muted-foreground">
              Subject
            </label>
            <Input
              id="compose-subject"
              value={state.subject}
              onChange={(event) => handleEdit("subject", event.target.value)}
              maxLength={GMAIL_COMPOSE_MAX_SUBJECT_LENGTH}
              disabled={isLocked}
            />
          </div>
        </div>

        <label htmlFor="compose-body" className="sr-only">
          Message body
        </label>
        <Textarea
          id="compose-body"
          value={state.body}
          onChange={(event) => handleEdit("body", event.target.value)}
          placeholder="Write your message"
          maxLength={GMAIL_COMPOSE_MAX_BODY_LENGTH}
          disabled={isLocked}
          required
          className="mt-6 min-h-64 flex-1 resize-none bg-card/35 px-4 py-4 text-[15px] leading-7"
        />

        <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-lg text-xs leading-5 text-muted-foreground">
            {state.message ? (
              <p
                className={
                  ["error", "send_error", "reconnect_required"].includes(
                    state.status,
                  )
                    ? "text-destructive"
                    : "text-success"
                }
                role={
                  ["error", "send_error", "reconnect_required"].includes(
                    state.status,
                  )
                    ? "alert"
                    : "status"
                }
                aria-live="polite"
              >
                {state.message}
              </p>
            ) : null}
            {isReconnectRequired ? (
              <div className="mt-2">
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`/v1/connections/gmail/start?accountId=${encodeURIComponent(gmailAccountId)}`}
                  >
                    Reconnect Gmail
                  </a>
                </Button>
              </div>
            ) : null}
          </div>
          {state.status === "confirming_send" ? (
            <div
              role="alertdialog"
              aria-label="Confirm Gmail send"
              className="flex flex-wrap items-center justify-end gap-2 rounded-xl bg-card px-3 py-2"
            >
              <p className="mr-1 text-xs text-muted-foreground">
                Send now to {state.recipients}?
              </p>
              <Button
                type="button"
                variant="ghost"
                onClick={() => dispatch({ type: "cancel_send" })}
              >
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSend()}>
                <HugeiconsIcon icon={MailSend02Icon} size={14} />
                Send now
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!isSent ? (
                <Button
                  type="submit"
                  variant="outline"
                  disabled={isLocked || isCurrentDraftSaved}
                >
                  <HugeiconsIcon
                    icon={isCurrentDraftSaved ? CheckmarkCircle02Icon : MailAdd01Icon}
                    size={14}
                  />
                  {isSaving
                    ? "Saving to Gmail…"
                    : isCurrentDraftSaved
                      ? "Saved to Gmail drafts"
                      : state.providerDraft
                        ? "Update Gmail draft"
                        : "Save to Gmail drafts"}
                </Button>
              ) : null}
              {state.providerDraft ? (
                <Button
                  type="button"
                  disabled={!canRequestSend || isSending || isSent}
                  onClick={() => dispatch({ type: "confirm_send" })}
                >
                  <HugeiconsIcon
                    icon={isSent ? CheckmarkCircle02Icon : MailSend02Icon}
                    size={14}
                  />
                  {isSending
                    ? "Sending with Gmail…"
                    : isSent
                      ? "Sent with Gmail"
                      : state.status === "send_error"
                        ? "Retry send"
                        : "Send"}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </form>
    </section>
  );
}
