import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import {
  getDatabase,
  type Database,
  type DatabaseTransaction,
} from "./client";
import {
  agentConversations,
  agentMessages,
  agentSocketTickets,
  authSessions,
  profiles,
} from "./schema";

/**
 * A turn renews its lease after every agent step, so the lease only has to
 * outlive the slowest single step before another process may take over.
 */
const AGENT_RUN_LEASE_SECONDS = 600;

export type AgentMessageRole = "user" | "assistant";

/** A UI message as the agent runtime stores it; parts are validated on read. */
export type StoredAgentMessage = {
  id: string;
  role: AgentMessageRole;
  parts: unknown[];
};

export type AgentConversationRecord = {
  id: string;
  title: string;
  updatedAt: Date;
};

export type StartAgentRunResult =
  | { outcome: "started"; messages: StoredAgentMessage[] }
  | { outcome: "busy" }
  | { outcome: "not_found" };

export class AgentMessageConflictError extends Error {
  constructor() {
    super("The agent message ID belongs to another conversation or role.");
    this.name = "AgentMessageConflictError";
  }
}

const leaseExpiry = sql`now() + make_interval(secs => ${AGENT_RUN_LEASE_SECONDS})`;

async function listStoredAgentMessages(
  conversationId: string,
  database: Database | DatabaseTransaction,
): Promise<StoredAgentMessage[]> {
  return database
    .select({
      id: agentMessages.id,
      role: agentMessages.role,
      parts: agentMessages.parts,
    })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.position));
}

/**
 * Appends new messages after the conversation's last position and replaces the
 * parts of messages it already holds. The caller holds the conversation lease,
 * which serializes position allocation.
 */
async function saveMessages(
  transaction: DatabaseTransaction,
  input: { userId: string; conversationId: string },
  messages: StoredAgentMessage[],
): Promise<void> {
  const [last] = await transaction
    .select({ position: sql<number | null>`max(${agentMessages.position})` })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, input.conversationId));
  let nextPosition = (last?.position ?? -1) + 1;
  for (const message of messages) {
    const [saved] = await transaction
      .insert(agentMessages)
      .values({
        id: message.id,
        conversationId: input.conversationId,
        userId: input.userId,
        position: nextPosition,
        role: message.role,
        parts: message.parts,
      })
      .onConflictDoUpdate({
        target: agentMessages.id,
        set: { parts: sql`excluded.parts`, updatedAt: sql`now()` },
        setWhere: and(
          eq(agentMessages.conversationId, input.conversationId),
          eq(agentMessages.userId, input.userId),
          eq(agentMessages.role, message.role),
        ),
      })
      .returning({ position: agentMessages.position });
    if (!saved) throw new AgentMessageConflictError();
    // A replaced message keeps its earlier position; only an insert uses this one.
    if (saved.position === nextPosition) nextPosition += 1;
  }
}

/**
 * Claims the conversation for one turn. A new user message creates the
 * conversation when needed and is stored in the same transaction as the claim,
 * so a turn never starts without its request on record.
 */
export async function startAgentRun(
  input: {
    userId: string;
    conversationId: string;
    runId: string;
    newMessage: { message: StoredAgentMessage; title: string } | null;
  },
  database: Database = getDatabase(),
): Promise<StartAgentRunResult> {
  return database.transaction(async (transaction) => {
    if (input.newMessage) {
      await transaction
        .insert(agentConversations)
        .values({
          id: input.conversationId,
          userId: input.userId,
          title: input.newMessage.title,
        })
        .onConflictDoNothing({ target: agentConversations.id });
    }
    const [leased] = await transaction
      .update(agentConversations)
      .set({ activeRunId: input.runId, activeRunExpiresAt: leaseExpiry })
      .where(
        and(
          eq(agentConversations.id, input.conversationId),
          eq(agentConversations.userId, input.userId),
          or(
            isNull(agentConversations.activeRunId),
            lte(agentConversations.activeRunExpiresAt, sql`now()`),
          ),
        ),
      )
      .returning({ id: agentConversations.id });
    if (!leased) {
      const [existing] = await transaction
        .select({ id: agentConversations.id })
        .from(agentConversations)
        .where(
          and(
            eq(agentConversations.id, input.conversationId),
            eq(agentConversations.userId, input.userId),
          ),
        )
        .limit(1);
      return existing ? { outcome: "busy" } : { outcome: "not_found" };
    }
    if (input.newMessage) {
      await saveMessages(transaction, input, [input.newMessage.message]);
    }
    return {
      outcome: "started",
      messages: await listStoredAgentMessages(input.conversationId, transaction),
    };
  });
}

/**
 * Stores messages only while the run still holds the conversation, so a turn
 * whose lease was taken over cannot overwrite the newer turn's history.
 */
export async function saveAgentRunMessages(
  input: {
    userId: string;
    conversationId: string;
    runId: string;
    messages: StoredAgentMessage[];
    finishRun: boolean;
  },
  database: Database = getDatabase(),
): Promise<{ saved: boolean }> {
  return database.transaction(async (transaction) => {
    const [owned] = await transaction
      .select({ id: agentConversations.id })
      .from(agentConversations)
      .where(
        and(
          eq(agentConversations.id, input.conversationId),
          eq(agentConversations.userId, input.userId),
          eq(agentConversations.activeRunId, input.runId),
        ),
      )
      .for("update")
      .limit(1);
    if (!owned) return { saved: false };
    await saveMessages(transaction, input, input.messages);
    await transaction
      .update(agentConversations)
      .set(
        input.finishRun
          ? { activeRunId: null, activeRunExpiresAt: null }
          : { activeRunExpiresAt: leaseExpiry },
      )
      .where(eq(agentConversations.id, input.conversationId));
    return { saved: true };
  });
}

export async function renewAgentRun(
  input: { conversationId: string; runId: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  const renewed = await database
    .update(agentConversations)
    .set({ activeRunExpiresAt: leaseExpiry })
    .where(
      and(
        eq(agentConversations.id, input.conversationId),
        eq(agentConversations.activeRunId, input.runId),
      ),
    )
    .returning({ id: agentConversations.id });
  return renewed.length > 0;
}

export async function finishAgentRun(
  input: { conversationId: string; runId: string },
  database: Database = getDatabase(),
): Promise<void> {
  await database
    .update(agentConversations)
    .set({ activeRunId: null, activeRunExpiresAt: null })
    .where(
      and(
        eq(agentConversations.id, input.conversationId),
        eq(agentConversations.activeRunId, input.runId),
      ),
    );
}

export async function listAgentConversations(
  input: { userId: string; limit: number },
  database: Database = getDatabase(),
): Promise<AgentConversationRecord[]> {
  return database
    .select({
      id: agentConversations.id,
      title: agentConversations.title,
      updatedAt: agentConversations.updatedAt,
    })
    .from(agentConversations)
    .where(eq(agentConversations.userId, input.userId))
    .orderBy(desc(agentConversations.updatedAt), desc(agentConversations.id))
    .limit(input.limit);
}

export async function getAgentConversation(
  input: { userId: string; conversationId: string },
  database: Database = getDatabase(),
): Promise<{
  conversation: AgentConversationRecord;
  messages: StoredAgentMessage[];
} | null> {
  const [conversation] = await database
    .select({
      id: agentConversations.id,
      title: agentConversations.title,
      updatedAt: agentConversations.updatedAt,
    })
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.id, input.conversationId),
        eq(agentConversations.userId, input.userId),
      ),
    )
    .limit(1);
  if (!conversation) return null;
  return {
    conversation,
    messages: await listStoredAgentMessages(conversation.id, database),
  };
}

/** Stores a ticket by hash; the raw value exists only in the issuing response. */
export async function createAgentSocketTicket(
  input: {
    tokenHash: string;
    userId: string;
    sessionId: string;
    expiresAt: Date;
  },
  database: Database = getDatabase(),
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .delete(agentSocketTickets)
      .where(
        and(
          eq(agentSocketTickets.userId, input.userId),
          lte(agentSocketTickets.expiresAt, sql`now()`),
        ),
      );
    await transaction.insert(agentSocketTickets).values(input);
  });
}

/** Deleting on read makes each ticket usable for exactly one connection. */
export async function consumeAgentSocketTicket(
  input: { tokenHash: string },
  database: Database = getDatabase(),
): Promise<{ userId: string; sessionId: string } | null> {
  const [ticket] = await database
    .delete(agentSocketTickets)
    .where(
      and(
        eq(agentSocketTickets.tokenHash, input.tokenHash),
        gt(agentSocketTickets.expiresAt, sql`now()`),
      ),
    )
    .returning({
      userId: agentSocketTickets.userId,
      sessionId: agentSocketTickets.sessionId,
    });
  return ticket ?? null;
}

/**
 * Reads the signed-in identity behind a socket directly from the session
 * table, so signing out ends agent access at the next turn.
 */
export async function getAgentSessionIdentity(
  input: { userId: string; sessionId: string },
  database: Database = getDatabase(),
): Promise<{ name: string; email: string } | null> {
  const [identity] = await database
    .select({ name: profiles.displayName, email: profiles.email })
    .from(authSessions)
    .innerJoin(profiles, eq(profiles.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.id, input.sessionId),
        eq(authSessions.userId, input.userId),
        gt(authSessions.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return identity ?? null;
}
