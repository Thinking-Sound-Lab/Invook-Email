import type { GmailComposeDraft } from "@invook/contracts";

export type ComposeDraftStatus = "editing" | "saving" | "saved" | "error";

export interface ComposeDraftState {
  recipients: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  providerDraft: GmailComposeDraft | null;
  status: ComposeDraftStatus;
  message: string | null;
}

export type ComposeDraftAction =
  | {
      type: "edit";
      field: "recipients" | "subject" | "body";
      value: string;
      idempotencyKey: string;
    }
  | { type: "saving" }
  | { type: "saved"; draft: GmailComposeDraft }
  | { type: "error"; message: string };

export function createComposeDraftState(idempotencyKey: string): ComposeDraftState {
  return {
    recipients: "",
    subject: "",
    body: "",
    idempotencyKey,
    providerDraft: null,
    status: "editing",
    message: null,
  };
}

export function composeDraftReducer(
  state: ComposeDraftState,
  action: ComposeDraftAction,
): ComposeDraftState {
  switch (action.type) {
    case "edit":
      return {
        ...state,
        [action.field]: action.value,
        idempotencyKey: action.idempotencyKey,
        status: "editing",
        message: null,
      };
    case "saving":
      return { ...state, status: "saving", message: null };
    case "saved":
      return {
        ...state,
        providerDraft: action.draft,
        status: "saved",
        message:
          "Saved to Gmail drafts. Invook will reflect it here after Gmail history catches up.",
      };
    case "error":
      return { ...state, status: "error", message: action.message };
    default: {
      const exhaustiveAction: never = action;
      return exhaustiveAction;
    }
  }
}
