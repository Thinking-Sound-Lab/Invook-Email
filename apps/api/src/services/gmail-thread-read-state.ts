import { enqueueGmailHistoryCatchup } from "@invook/database";
import {
  modifyGmailThreadLabels,
  type GmailSystemLabelId,
} from "@invook/gmail";

import type { GmailProviderAccess } from "./gmail-provider";

export interface GmailThreadMutationContext {
  accountId: string;
  providerThreadId: string;
}

export interface SetGmailThreadReadStateInput {
  access: GmailProviderAccess;
  context: GmailThreadMutationContext | null;
  isRead: boolean;
  userId: string;
}

export interface GmailThreadReadStateDependencies {
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

const defaultDependencies: GmailThreadReadStateDependencies = {
  enqueueHistoryCatchup: enqueueGmailHistoryCatchup,
  modifyThreadLabels: modifyGmailThreadLabels,
};

export function gmailThreadReadStateMutation(isRead: boolean): {
  addLabelIds?: GmailSystemLabelId[];
  removeLabelIds?: GmailSystemLabelId[];
} {
  return isRead
    ? { removeLabelIds: ["UNREAD"] }
    : { addLabelIds: ["UNREAD"] };
}

export async function setGmailThreadReadState(
  input: SetGmailThreadReadStateInput,
  dependencies: GmailThreadReadStateDependencies = defaultDependencies,
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
    gmailThreadReadStateMutation(input.isRead),
  );
  const stepId = await dependencies.enqueueHistoryCatchup({
    userId: input.userId,
    accountId: input.access.accountId,
    reason: "provider_write",
  });
  return { status: "complete", stepId };
}
