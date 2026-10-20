import { enqueueGmailHistoryCatchup } from "@invook/database";
import {
  modifyGmailThreadLabels,
  type GmailSystemLabelId,
} from "@invook/gmail";

import type { GmailProviderAccess } from "./gmail-provider";

interface GmailThreadMutationContext {
  accountId: string;
  providerThreadId: string;
}

/** Thread-wide changes that apply to every message in a Gmail thread. */
export const gmailThreadActions = ["mark_read", "mark_unread", "archive"] as const;
export type GmailThreadAction = (typeof gmailThreadActions)[number];

export interface ApplyGmailThreadActionInput {
  access: GmailProviderAccess;
  context: GmailThreadMutationContext | null;
  action: GmailThreadAction;
  userId: string;
}

export interface GmailThreadActionDependencies {
  enqueueHistoryCatchup: (input: {
    userId: string;
    accountId: string;
    reason: "provider_write";
  }) => Promise<string>;
  modifyThreadLabels: (
    accessToken: string,
    providerThreadId: string,
    changes: {
      addLabelIds?: GmailSystemLabelId[];
      removeLabelIds?: GmailSystemLabelId[];
    },
  ) => Promise<void>;
}

const defaultDependencies: GmailThreadActionDependencies = {
  enqueueHistoryCatchup: enqueueGmailHistoryCatchup,
  modifyThreadLabels: modifyGmailThreadLabels,
};

function gmailThreadActionMutation(action: GmailThreadAction): {
  addLabelIds?: GmailSystemLabelId[];
  removeLabelIds?: GmailSystemLabelId[];
} {
  switch (action) {
    case "mark_read":
      return { removeLabelIds: ["UNREAD"] };
    case "mark_unread":
      return { addLabelIds: ["UNREAD"] };
    case "archive":
      return { removeLabelIds: ["INBOX"] };
  }
}

export async function applyGmailThreadAction(
  input: ApplyGmailThreadActionInput,
  dependencies: GmailThreadActionDependencies = defaultDependencies,
): Promise<
  | { status: "not_found" }
  | { status: "complete"; stepId: string }
> {
  if (!input.context || input.context.accountId !== input.access.accountId) {
    return { status: "not_found" };
  }

  await dependencies.modifyThreadLabels(
    input.access.accessToken,
    input.context.providerThreadId,
    gmailThreadActionMutation(input.action),
  );
  const stepId = await dependencies.enqueueHistoryCatchup({
    userId: input.userId,
    accountId: input.access.accountId,
    reason: "provider_write",
  });
  return { status: "complete", stepId };
}
