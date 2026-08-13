import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  MailboxActionOperation,
  MailboxActionStatus,
} from "@invook/contracts";
import { validate as validateUuid } from "uuid";

import {
  getDatabase,
  type Database,
  type DatabaseExecutor,
} from "./client";
import {
  connectedAccounts,
  drafts,
  gmailLabels,
  gmailMessageLabels,
  gmailReplicaStates,
  mailLabels,
  mailboxActionProposals,
  mailboxActionTargets,
  messages,
  threadLabels,
  threads,
} from "./schema";
import { enqueueWorkflowStepWithExecutor } from "./workflows";

export type QueryInvookMailboxInput = {
  userId: string;
  candidateMessageIds?: string[];
  gmailLabelIds?: string[];
  invookLabelIds?: string[];
  inboxState?: "any" | "inbox" | "not_inbox";
  readState?: "any" | "read" | "unread";
  sender?: string;
  sentAfter?: Date;
  sentBefore?: Date;
  cursor?: string;
  limit?: number;
};

export type CreateMailboxActionProposalInput =
  | {
      userId: string;
      toolCallId: string;
      operation: Exclude<
        MailboxActionOperation,
        "apply_gmail_label" | "remove_gmail_label" | "save_draft_to_gmail"
      >;
      messageIds: string[];
    }
  | {
      userId: string;
      toolCallId: string;
      operation: "apply_gmail_label" | "remove_gmail_label";
      messageIds: string[];
      gmailLabelId: string;
    }
  | {
      userId: string;
      toolCallId: string;
      operation: "save_draft_to_gmail";
      draftId: string;
    };

export class MailboxActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxActionInputError";
  }
}

export class MailboxActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxActionConflictError";
  }
}

export function mailboxActionApprovalDecision(
  status: MailboxActionStatus,
): "enqueue" | "already_approved" | "cancelled" {
  if (status === "pending") return "enqueue";
  return status === "cancelled" ? "cancelled" : "already_approved";
}

type QueryCursor = { sentAt: Date; messageId: string };

function parseQueryCursor(value: string): QueryCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      sentAt?: unknown;
      messageId?: unknown;
    };
    if (typeof decoded.sentAt !== "string" || typeof decoded.messageId !== "string") {
      return null;
    }
    const sentAt = new Date(decoded.sentAt);
    if (!Number.isFinite(sentAt.getTime()) || !validateUuid(decoded.messageId)) {
      return null;
    }
    return { sentAt, messageId: decoded.messageId };
  } catch {
    return null;
  }
}

function createQueryCursor(message: { id: string; sentAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ sentAt: message.sentAt.toISOString(), messageId: message.id }),
  ).toString("base64url");
}

function gmailMembership(providerLabelId: string) {
  return sql<boolean>`exists (
    select 1
    from ${gmailMessageLabels} membership
    inner join ${gmailLabels} label on label.id = membership.gmail_label_id
    where membership.message_id = ${messages.id}
      and label.provider_label_id = ${providerLabelId}
  )`;
}

export async function queryInvookMailbox(
  input: QueryInvookMailboxInput,
  database: Database = getDatabase(),
) {
  const [account] = await database
    .select({ id: connectedAccounts.id, replicaState: gmailReplicaStates.state })
    .from(connectedAccounts)
    .innerJoin(
      gmailReplicaStates,
      eq(gmailReplicaStates.accountId, connectedAccounts.id),
    )
    .where(
      and(
        eq(connectedAccounts.userId, input.userId),
        eq(connectedAccounts.status, "connected"),
      ),
    )
    .orderBy(desc(connectedAccounts.createdAt))
    .limit(1);
  if (!account) {
    return { status: "unavailable" as const, reason: "mailbox_not_connected" as const };
  }
  if (account.replicaState !== "ready") {
    return { status: "unavailable" as const, reason: "replica_not_ready" as const };
  }

  const limit = Math.max(1, Math.min(input.limit ?? 25, 50));
  const cursor = input.cursor ? parseQueryCursor(input.cursor) : null;
  if (input.cursor && !cursor) {
    throw new MailboxActionInputError("The mailbox query cursor is invalid.");
  }
  const [availableGmailLabels, availableInvookLabels] = await Promise.all([
    database
      .select({ id: gmailLabels.id, name: gmailLabels.name })
      .from(gmailLabels)
      .where(eq(gmailLabels.accountId, account.id))
      .orderBy(asc(gmailLabels.name)),
    database
      .select({ id: mailLabels.id, name: mailLabels.name })
      .from(mailLabels)
      .where(eq(mailLabels.accountId, account.id))
      .orderBy(asc(mailLabels.name)),
  ]);
  if (input.candidateMessageIds && input.candidateMessageIds.length === 0) {
    return {
      status: "available" as const,
      messages: [],
      availableGmailLabels,
      availableInvookLabels,
      nextCursor: null,
    };
  }

  const conditions = [
    eq(messages.userId, input.userId),
    eq(messages.accountId, account.id),
  ];
  if (input.candidateMessageIds) {
    conditions.push(inArray(messages.id, input.candidateMessageIds));
  }
  for (const gmailLabelId of input.gmailLabelIds ?? []) {
    conditions.push(sql<boolean>`exists (
      select 1 from ${gmailMessageLabels} membership
      where membership.message_id = ${messages.id}
        and membership.gmail_label_id = ${gmailLabelId}
    )`);
  }
  for (const invookLabelId of input.invookLabelIds ?? []) {
    conditions.push(sql<boolean>`exists (
      select 1 from ${threadLabels} membership
      where membership.thread_id = ${messages.threadId}
        and membership.label_id = ${invookLabelId}
        and membership.state = 'applied'
    )`);
  }
  const isInbox = gmailMembership("INBOX");
  const isUnread = gmailMembership("UNREAD");
  if (input.inboxState === "inbox") conditions.push(isInbox);
  if (input.inboxState === "not_inbox") conditions.push(sql<boolean>`not (${isInbox})`);
  if (input.readState === "unread") conditions.push(isUnread);
  if (input.readState === "read") conditions.push(sql<boolean>`not (${isUnread})`);
  if (input.sender?.trim()) {
    const sender = input.sender.trim().toLowerCase();
    conditions.push(
      sql<boolean>`(
        lower(${messages.sender}->>'email') = ${sender}
        or lower(${messages.sender}->>'raw') like ${`%${sender}%`}
      )`,
    );
  }
  if (input.sentAfter) conditions.push(gte(messages.sentAt, input.sentAfter));
  if (input.sentBefore) conditions.push(lte(messages.sentAt, input.sentBefore));
  if (cursor) {
    conditions.push(
      or(
        lt(messages.sentAt, cursor.sentAt),
        and(eq(messages.sentAt, cursor.sentAt), lt(messages.id, cursor.messageId)),
      )!,
    );
  }

  const rows = await database
    .select({
      id: messages.id,
      threadId: messages.threadId,
      subject: messages.subject,
      bodyText: messages.bodyText,
      sender: messages.sender,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const messageIds = page.map((message) => message.id);
  const threadIds = [...new Set(page.map((message) => message.threadId))];
  const gmailMemberships =
    messageIds.length === 0
      ? []
      : await database
          .select({
            messageId: gmailMessageLabels.messageId,
            id: gmailLabels.id,
            name: gmailLabels.name,
            providerLabelId: gmailLabels.providerLabelId,
          })
          .from(gmailMessageLabels)
          .innerJoin(gmailLabels, eq(gmailLabels.id, gmailMessageLabels.gmailLabelId))
          .where(inArray(gmailMessageLabels.messageId, messageIds))
          .orderBy(asc(gmailLabels.name));
  const invookMemberships =
    threadIds.length === 0
      ? []
      : await database
          .select({ threadId: threadLabels.threadId, id: mailLabels.id, name: mailLabels.name })
          .from(threadLabels)
          .innerJoin(mailLabels, eq(mailLabels.id, threadLabels.labelId))
          .where(
            and(
              inArray(threadLabels.threadId, threadIds),
              eq(threadLabels.state, "applied"),
            ),
          )
          .orderBy(asc(mailLabels.name));

  return {
    status: "available" as const,
    messages: page.map((message) => {
      const messageGmailLabels = gmailMemberships.filter(
        (membership) => membership.messageId === message.id,
      );
      return {
        messageId: message.id,
        threadId: message.threadId,
        subject: message.subject,
        bodyPreview: message.bodyText.slice(0, 800),
        sender: message.sender,
        sentAt: message.sentAt,
        isInbox: messageGmailLabels.some(
          (membership) => membership.providerLabelId === "INBOX",
        ),
        isUnread: messageGmailLabels.some(
          (membership) => membership.providerLabelId === "UNREAD",
        ),
        gmailLabels: messageGmailLabels.map(({ id, name }) => ({ id, name })),
        invookLabels: invookMemberships
          .filter((membership) => membership.threadId === message.threadId)
          .map(({ id, name }) => ({ id, name })),
      };
    }),
    availableGmailLabels,
    availableInvookLabels,
    nextCursor:
      rows.length > limit && page.length > 0
        ? createQueryCursor(page[page.length - 1]!)
        : null,
  };
}

function requestFingerprint(input: CreateMailboxActionProposalInput): string {
  const targetIds =
    input.operation === "save_draft_to_gmail"
      ? [input.draftId]
      : [...new Set(input.messageIds)].sort();
  const labelId =
    input.operation === "apply_gmail_label" ||
    input.operation === "remove_gmail_label"
      ? input.gmailLabelId
      : null;
  return createHash("sha256")
    .update(JSON.stringify({ operation: input.operation, targetIds, labelId }))
    .digest("hex");
}

async function getProposal(
  proposalId: string,
  database: DatabaseExecutor,
  userId?: string,
) {
  const conditions = [eq(mailboxActionProposals.id, proposalId)];
  if (userId) conditions.push(eq(mailboxActionProposals.userId, userId));
  const [proposal] = await database
    .select()
    .from(mailboxActionProposals)
    .where(and(...conditions))
    .limit(1);
  if (!proposal) return null;
  const targets = await database
    .select()
    .from(mailboxActionTargets)
    .where(eq(mailboxActionTargets.proposalId, proposal.id))
    .orderBy(asc(mailboxActionTargets.createdAt), asc(mailboxActionTargets.id));
  return { ...proposal, targets };
}

export async function getMailboxActionProposalForUser(
  input: { userId: string; proposalId: string },
  database: Database = getDatabase(),
) {
  return getProposal(input.proposalId, database, input.userId);
}

export async function createMailboxActionProposal(
  input: CreateMailboxActionProposalInput,
  database: Database = getDatabase(),
) {
  const fingerprint = requestFingerprint(input);
  const idempotencyKey = `agent-tool:${input.userId}:${input.toolCallId}`;
  const [existing] = await database
    .select({
      id: mailboxActionProposals.id,
      requestFingerprint: mailboxActionProposals.requestFingerprint,
    })
    .from(mailboxActionProposals)
    .where(eq(mailboxActionProposals.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new MailboxActionConflictError(
        "The Agent tool call cannot be reused with different action targets.",
      );
    }
    return getProposal(existing.id, database, input.userId);
  }

  return database.transaction(async (transaction) => {
    const [account] = await transaction
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .innerJoin(
        gmailReplicaStates,
        eq(gmailReplicaStates.accountId, connectedAccounts.id),
      )
      .where(
        and(
          eq(connectedAccounts.userId, input.userId),
          eq(connectedAccounts.status, "connected"),
          eq(gmailReplicaStates.state, "ready"),
        ),
      )
      .orderBy(desc(connectedAccounts.createdAt))
      .limit(1);
    if (!account) {
      throw new MailboxActionInputError(
        "Mailbox actions require a fully synchronized local replica.",
      );
    }

    let gmailLabel: { id: string; providerLabelId: string; name: string } | undefined;
    if (
      input.operation === "apply_gmail_label" ||
      input.operation === "remove_gmail_label"
    ) {
      [gmailLabel] = await transaction
        .select({
          id: gmailLabels.id,
          providerLabelId: gmailLabels.providerLabelId,
          name: gmailLabels.name,
        })
        .from(gmailLabels)
        .where(
          and(
            eq(gmailLabels.id, input.gmailLabelId),
            eq(gmailLabels.accountId, account.id),
          ),
        )
        .limit(1);
      if (!gmailLabel) {
        throw new MailboxActionInputError("The requested Gmail label was not found.");
      }
    }

    const targetValues: Array<typeof mailboxActionTargets.$inferInsert> = [];
    if (input.operation === "save_draft_to_gmail") {
      const [draft] = await transaction
        .select({
          id: drafts.id,
          threadId: drafts.threadId,
          providerThreadId: threads.providerThreadId,
          subject: threads.subject,
          updatedAt: drafts.updatedAt,
        })
        .from(drafts)
        .innerJoin(threads, eq(threads.id, drafts.threadId))
        .where(
          and(
            eq(drafts.id, input.draftId),
            eq(drafts.userId, input.userId),
            eq(drafts.accountId, account.id),
            eq(drafts.status, "editing"),
          ),
        )
        .limit(1);
      if (!draft) {
        throw new MailboxActionInputError("The requested editable AI draft was not found.");
      }
      targetValues.push({
        proposalId: "00000000-0000-0000-0000-000000000000",
        userId: input.userId,
        accountId: account.id,
        draftId: draft.id,
        threadId: draft.threadId,
        providerThreadId: draft.providerThreadId,
        subject: draft.subject,
        expectedUpdatedAt: draft.updatedAt,
      });
    } else {
      const messageIds = [...new Set(input.messageIds)];
      if (messageIds.length === 0 || messageIds.length > 100) {
        throw new MailboxActionInputError(
          "Mailbox action proposals require between one and 100 exact messages.",
        );
      }
      const targetMessages = await transaction
        .select({
          id: messages.id,
          threadId: messages.threadId,
          providerMessageId: messages.providerMessageId,
          providerThreadId: threads.providerThreadId,
          subject: messages.subject,
          sender: messages.sender,
          sentAt: messages.sentAt,
          updatedAt: messages.updatedAt,
        })
        .from(messages)
        .innerJoin(threads, eq(threads.id, messages.threadId))
        .where(
          and(
            eq(messages.userId, input.userId),
            eq(messages.accountId, account.id),
            inArray(messages.id, messageIds),
          ),
        );
      if (targetMessages.length !== messageIds.length) {
        throw new MailboxActionInputError(
          "Every mailbox action target must be a current message in the authenticated local replica.",
        );
      }
      const messagesById = new Map(
        targetMessages.map((message) => [message.id, message] as const),
      );
      for (const messageId of messageIds) {
        const message = messagesById.get(messageId)!;
        targetValues.push({
          proposalId: "00000000-0000-0000-0000-000000000000",
          userId: input.userId,
          accountId: account.id,
          messageId: message.id,
          threadId: message.threadId,
          providerMessageId: message.providerMessageId,
          providerThreadId: message.providerThreadId,
          subject: message.subject,
          sender: message.sender.raw || message.sender.email,
          sentAt: message.sentAt,
          expectedUpdatedAt: message.updatedAt,
        });
      }
    }

    const [proposal] = await transaction
      .insert(mailboxActionProposals)
      .values({
        userId: input.userId,
        accountId: account.id,
        operation: input.operation,
        gmailLabelId: gmailLabel?.id ?? null,
        providerLabelId: gmailLabel?.providerLabelId ?? null,
        gmailLabelName: gmailLabel?.name ?? null,
        requestFingerprint: fingerprint,
        idempotencyKey,
      })
      .onConflictDoNothing({ target: mailboxActionProposals.idempotencyKey })
      .returning({ id: mailboxActionProposals.id });
    if (!proposal) {
      const [conflict] = await transaction
        .select({
          id: mailboxActionProposals.id,
          requestFingerprint: mailboxActionProposals.requestFingerprint,
        })
        .from(mailboxActionProposals)
        .where(eq(mailboxActionProposals.idempotencyKey, idempotencyKey))
        .limit(1);
      if (!conflict || conflict.requestFingerprint !== fingerprint) {
        throw new MailboxActionConflictError(
          "The Agent tool call cannot be reused with different action targets.",
        );
      }
      return getProposal(conflict.id, transaction, input.userId);
    }
    await transaction.insert(mailboxActionTargets).values(
      targetValues.map((target) => ({ ...target, proposalId: proposal.id })),
    );
    return getProposal(proposal.id, transaction, input.userId);
  });
}

export async function approveMailboxActionProposal(
  input: { userId: string; proposalId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [proposal] = await transaction
      .select({
        id: mailboxActionProposals.id,
        userId: mailboxActionProposals.userId,
        accountId: mailboxActionProposals.accountId,
        status: mailboxActionProposals.status,
      })
      .from(mailboxActionProposals)
      .where(
        and(
          eq(mailboxActionProposals.id, input.proposalId),
          eq(mailboxActionProposals.userId, input.userId),
        ),
      )
      .for("update")
      .limit(1);
    if (!proposal) return { outcome: "not_found" as const, proposal: null };
    const decision = mailboxActionApprovalDecision(proposal.status);
    if (decision === "cancelled") {
      return {
        outcome: "cancelled" as const,
        proposal: await getProposal(proposal.id, transaction, input.userId),
      };
    }
    if (decision === "already_approved") {
      return {
        outcome: "already_approved" as const,
        proposal: await getProposal(proposal.id, transaction, input.userId),
      };
    }
    const workflowStepId = await enqueueWorkflowStepWithExecutor(
      {
        userId: proposal.userId,
        accountId: proposal.accountId,
        stepType: "gmail.action.execute",
        payload: { proposalId: proposal.id },
        idempotencyKey: `gmail-action:${proposal.id}`,
      },
      transaction,
    );
    await transaction
      .update(mailboxActionProposals)
      .set({
        status: "executing",
        workflowStepId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mailboxActionProposals.id, proposal.id));
    return {
      outcome: "approved" as const,
      proposal: await getProposal(proposal.id, transaction, input.userId),
    };
  });
}

export async function cancelMailboxActionProposal(
  input: { userId: string; proposalId: string },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [proposal] = await transaction
      .select({ id: mailboxActionProposals.id, status: mailboxActionProposals.status })
      .from(mailboxActionProposals)
      .where(
        and(
          eq(mailboxActionProposals.id, input.proposalId),
          eq(mailboxActionProposals.userId, input.userId),
        ),
      )
      .for("update")
      .limit(1);
    if (!proposal) return { outcome: "not_found" as const, proposal: null };
    if (proposal.status !== "pending") {
      return {
        outcome: "not_pending" as const,
        proposal: await getProposal(proposal.id, transaction, input.userId),
      };
    }
    await transaction
      .update(mailboxActionProposals)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(mailboxActionProposals.id, proposal.id));
    return {
      outcome: "cancelled" as const,
      proposal: await getProposal(proposal.id, transaction, input.userId),
    };
  });
}

export async function getMailboxActionExecution(
  input: { proposalId: string; userId: string; accountId: string },
  database: Database = getDatabase(),
) {
  const proposal = await getProposal(input.proposalId, database);
  if (
    !proposal ||
    proposal.userId !== input.userId ||
    proposal.accountId !== input.accountId ||
    proposal.status !== "executing"
  ) {
    return null;
  }
  let isLabelCurrent = true;
  if (
    proposal.operation === "apply_gmail_label" ||
    proposal.operation === "remove_gmail_label"
  ) {
    const [label] = proposal.gmailLabelId
      ? await database
          .select({ providerLabelId: gmailLabels.providerLabelId })
          .from(gmailLabels)
          .where(
            and(
              eq(gmailLabels.id, proposal.gmailLabelId),
              eq(gmailLabels.accountId, proposal.accountId),
            ),
          )
          .limit(1)
      : [];
    isLabelCurrent = label?.providerLabelId === proposal.providerLabelId;
  }
  return { ...proposal, isLabelCurrent };
}

export async function claimMailboxActionTarget(
  input: { proposalId: string; targetId: string; operation: MailboxActionOperation },
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const [target] = await transaction
      .select()
      .from(mailboxActionTargets)
      .where(
        and(
          eq(mailboxActionTargets.id, input.targetId),
          eq(mailboxActionTargets.proposalId, input.proposalId),
        ),
      )
      .for("update")
      .limit(1);
    if (!target) return { state: "skip" as const, target: null };
    if (["completed", "failed", "stale"].includes(target.status)) {
      return { state: "skip" as const, target };
    }
    if (target.status === "executing" && input.operation === "save_draft_to_gmail") {
      await transaction
        .update(mailboxActionTargets)
        .set({
          status: "failed",
          errorCode: "provider_outcome_uncertain",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mailboxActionTargets.id, target.id));
      return { state: "skip" as const, target: { ...target, status: "failed" as const } };
    }

    let isCurrent = false;
    if (target.messageId && target.providerMessageId) {
      const [message] = await transaction
        .select({ providerMessageId: messages.providerMessageId })
        .from(messages)
        .where(
          and(
            eq(messages.id, target.messageId),
            eq(messages.userId, target.userId),
            eq(messages.accountId, target.accountId),
          ),
        )
        .limit(1);
      isCurrent = message?.providerMessageId === target.providerMessageId;
    } else if (target.draftId) {
      const [draft] = await transaction
        .select({ updatedAt: drafts.updatedAt, status: drafts.status })
        .from(drafts)
        .where(
          and(
            eq(drafts.id, target.draftId),
            eq(drafts.userId, target.userId),
            eq(drafts.accountId, target.accountId),
          ),
        )
        .limit(1);
      isCurrent =
        draft?.status === "editing" &&
        draft.updatedAt.getTime() === target.expectedUpdatedAt.getTime();
    }
    if (!isCurrent) {
      await transaction
        .update(mailboxActionTargets)
        .set({
          status: "stale",
          errorCode: "target_stale",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mailboxActionTargets.id, target.id));
      return { state: "stale" as const, target };
    }
    await transaction
      .update(mailboxActionTargets)
      .set({ status: "executing", errorCode: null, updatedAt: new Date() })
      .where(eq(mailboxActionTargets.id, target.id));
    return { state: "ready" as const, target: { ...target, status: "executing" as const } };
  });
}

export async function completeMailboxActionTarget(
  input: { targetId: string; evidence: Record<string, unknown> },
  database: Database = getDatabase(),
) {
  await database
    .update(mailboxActionTargets)
    .set({
      status: "completed",
      errorCode: null,
      providerEvidence: input.evidence,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailboxActionTargets.id, input.targetId));
}

export async function failMailboxActionTarget(
  input: { targetId: string; errorCode: string },
  database: Database = getDatabase(),
) {
  await database
    .update(mailboxActionTargets)
    .set({
      status: "failed",
      errorCode: input.errorCode,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailboxActionTargets.id, input.targetId));
}

export async function markMailboxActionTargetsStale(
  input: { proposalId: string; errorCode: string },
  database: Database = getDatabase(),
) {
  await database
    .update(mailboxActionTargets)
    .set({
      status: "stale",
      errorCode: input.errorCode,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailboxActionTargets.proposalId, input.proposalId),
        inArray(mailboxActionTargets.status, ["pending", "executing"]),
      ),
    );
}

export async function finalizeMailboxActionProposal(
  proposalId: string,
  database: Database = getDatabase(),
) {
  return database.transaction(async (transaction) => {
    const targets = await transaction
      .select({ status: mailboxActionTargets.status })
      .from(mailboxActionTargets)
      .where(eq(mailboxActionTargets.proposalId, proposalId));
    const completedCount = targets.filter((target) => target.status === "completed").length;
    const failedCount = targets.length - completedCount;
    const status: MailboxActionStatus =
      completedCount === targets.length
        ? "completed"
        : completedCount > 0
          ? "partial_failure"
          : "failed";
    await transaction
      .update(mailboxActionProposals)
      .set({ status, completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(mailboxActionProposals.id, proposalId),
          eq(mailboxActionProposals.status, "executing"),
        ),
      );
    return { status, completedCount, failedCount };
  });
}

export async function failMailboxActionProposalExecution(
  input: { proposalId: string; errorCode: string },
  database: Database = getDatabase(),
) {
  await database.transaction(async (transaction) => {
    await transaction
      .update(mailboxActionTargets)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailboxActionTargets.proposalId, input.proposalId),
          inArray(mailboxActionTargets.status, ["pending", "executing"]),
        ),
      );
    const [completed] = await transaction
      .select({ value: sql<number>`count(*)::integer` })
      .from(mailboxActionTargets)
      .where(
        and(
          eq(mailboxActionTargets.proposalId, input.proposalId),
          eq(mailboxActionTargets.status, "completed"),
        ),
      );
    await transaction
      .update(mailboxActionProposals)
      .set({
        status: (completed?.value ?? 0) > 0 ? "partial_failure" : "failed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailboxActionProposals.id, input.proposalId),
          eq(mailboxActionProposals.status, "executing"),
        ),
      );
  });
}
