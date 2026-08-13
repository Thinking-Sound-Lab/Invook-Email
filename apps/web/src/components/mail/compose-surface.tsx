"use client";

import {
  CheckmarkCircle02Icon,
  MailAdd01Icon,
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
  updateGmailComposeDraft,
} from "@/lib/api/compose-drafts";
import { apiErrorMessage } from "@/lib/http-error";

export function ComposeSurface() {
  const [state, dispatch] = useReducer(
    composeDraftReducer,
    undefined,
    () => createComposeDraftState(uuidv4()),
  );
  const isSaving = state.status === "saving";
  const isSaved = state.status === "saved";

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
      dispatch({ type: "saved", draft: result.draft });
    } catch (error) {
      dispatch({
        type: "error",
        message: apiErrorMessage(error, "Invook could not save this draft to Gmail."),
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
              disabled={isSaving}
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
              disabled={isSaving}
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
          disabled={isSaving}
          required
          className="mt-6 min-h-64 flex-1 resize-none bg-card/35 px-4 py-4 text-[15px] leading-7"
        />

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-lg text-xs leading-5 text-muted-foreground">
            <p>Sending isn&apos;t available here. This action only saves a draft in Gmail.</p>
            {state.message ? (
              <p
                className={state.status === "error" ? "mt-1 text-destructive" : "mt-1 text-success"}
                role={state.status === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {state.message}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={isSaving || isSaved}>
            <HugeiconsIcon
              icon={isSaved ? CheckmarkCircle02Icon : MailAdd01Icon}
              size={14}
            />
            {isSaving
              ? "Saving to Gmail…"
              : isSaved
                ? "Saved to Gmail drafts"
                : state.providerDraft
                  ? "Update Gmail draft"
                  : "Save to Gmail drafts"}
          </Button>
        </div>
      </form>
    </section>
  );
}
