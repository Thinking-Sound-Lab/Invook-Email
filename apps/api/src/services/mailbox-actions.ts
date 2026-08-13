import type {
  MailboxActionProposal,
  MailboxQueryResult,
} from "@invook/contracts";
import {
  createMailboxActionProposal,
  queryInvookMailbox,
  type CreateMailboxActionProposalInput,
} from "@invook/database";

import { searchMailForUser } from "./search";

type StoredProposal = NonNullable<
  Awaited<ReturnType<typeof createMailboxActionProposal>>
>;

export function serializeMailboxActionProposal(
  proposal: StoredProposal,
): MailboxActionProposal {
  return {
    id: proposal.id,
    operation: proposal.operation,
    status: proposal.status,
    gmailLabel:
      proposal.gmailLabelId && proposal.gmailLabelName
        ? { id: proposal.gmailLabelId, name: proposal.gmailLabelName }
        : null,
    targets: proposal.targets.map((target) => ({
      id: target.id,
      messageId: target.messageId,
      draftId: target.draftId,
      threadId: target.threadId,
      subject: target.subject,
      sender: target.sender,
      sentAt: target.sentAt?.toISOString() ?? null,
      status: target.status,
      errorCode: target.errorCode,
    })),
    createdAt: proposal.createdAt.toISOString(),
    approvedAt: proposal.approvedAt?.toISOString() ?? null,
    completedAt: proposal.completedAt?.toISOString() ?? null,
  };
}

export async function createMailboxActionProposalForUser(
  input: CreateMailboxActionProposalInput,
): Promise<MailboxActionProposal> {
  const proposal = await createMailboxActionProposal(input);
  if (!proposal) {
    throw new Error("The mailbox action proposal could not be created.");
  }
  return serializeMailboxActionProposal(proposal);
}

export async function queryMailboxForUser(input: {
  userId: string;
  searchText?: string;
  gmailLabelIds?: string[];
  invookLabelIds?: string[];
  inboxState?: "any" | "inbox" | "not_inbox";
  readState?: "any" | "read" | "unread";
  sender?: string;
  sentAfter?: string;
  sentBefore?: string;
  cursor?: string;
  limit?: number;
}): Promise<MailboxQueryResult> {
  const searchResults = input.searchText
    ? await searchMailForUser({
        userId: input.userId,
        query: input.searchText,
        limit: 50,
      })
    : null;
  const result = await queryInvookMailbox({
    userId: input.userId,
    candidateMessageIds: searchResults?.map((result) => result.messageId),
    gmailLabelIds: input.gmailLabelIds,
    invookLabelIds: input.invookLabelIds,
    inboxState: input.inboxState,
    readState: input.readState,
    sender: input.sender,
    sentAfter: input.sentAfter ? new Date(input.sentAfter) : undefined,
    sentBefore: input.sentBefore ? new Date(input.sentBefore) : undefined,
    cursor: input.cursor,
    limit: input.limit,
  });
  if (result.status === "unavailable") {
    return { ...result, messages: [], nextCursor: null };
  }
  return {
    status: "available",
    messages: result.messages.map((message) => ({
      ...message,
      sentAt: message.sentAt.toISOString(),
    })),
    availableGmailLabels: result.availableGmailLabels,
    availableInvookLabels: result.availableInvookLabels,
    nextCursor: result.nextCursor,
  };
}
