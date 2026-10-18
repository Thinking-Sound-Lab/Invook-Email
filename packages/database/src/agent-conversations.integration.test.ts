import assert from "node:assert/strict";
import test from "node:test";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  AgentMessageConflictError,
  consumeAgentSocketTicket,
  createAgentSocketTicket,
  deleteAgentConversation,
  getAgentConversation,
  getAgentSessionIdentity,
  listAgentConversations,
  saveAgentRunMessages,
  startAgentRun,
} from "./agent-conversations";
import * as schema from "./schema";
import { agentConversations, authSessions, profiles } from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function userMessage(text: string) {
  return {
    id: uuidv4(),
    role: "user" as const,
    parts: [{ type: "text", text }],
  };
}

test(
  "one run holds a conversation, and only it can store the turn's history",
  { skip: !testDatabaseUrl },
  async () => {
    assert.ok(testDatabaseUrl);
    const client = postgres(testDatabaseUrl, { max: 2, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const otherUserId = uuidv4();
    const conversationId = uuidv4();
    try {
      await database.insert(profiles).values([
        { id: userId, displayName: "Agent Owner", email: `${userId}@example.test` },
        { id: otherUserId, displayName: "Someone Else", email: `${otherUserId}@example.test` },
      ]);
      const firstRun = uuidv4();
      const firstMessage = userMessage("Find the lease");
      const started = await startAgentRun(
        {
          userId,
          conversationId,
          runId: firstRun,
          newMessage: { message: firstMessage, title: "Find the lease" },
        },
        database,
      );
      assert.deepEqual(started, { outcome: "started", messages: [firstMessage] });

      // The same conversation cannot start a second turn, and another user
      // cannot see that it exists.
      assert.deepEqual(
        await startAgentRun(
          {
            userId,
            conversationId,
            runId: uuidv4(),
            newMessage: { message: userMessage("Again"), title: "Again" },
          },
          database,
        ),
        { outcome: "busy" },
      );
      assert.deepEqual(
        await startAgentRun(
          {
            userId: otherUserId,
            conversationId,
            runId: uuidv4(),
            newMessage: { message: userMessage("Mine"), title: "Mine" },
          },
          database,
        ),
        { outcome: "not_found" },
      );

      const assistantId = uuidv4();
      assert.deepEqual(
        await saveAgentRunMessages(
          {
            userId,
            conversationId,
            runId: uuidv4(),
            messages: [{ id: assistantId, role: "assistant", parts: [] }],
            finishRun: true,
          },
          database,
        ),
        { saved: false },
      );
      assert.deepEqual(
        await saveAgentRunMessages(
          {
            userId,
            conversationId,
            runId: firstRun,
            messages: [
              { id: assistantId, role: "assistant", parts: [{ type: "text", text: "Pending" }] },
            ],
            finishRun: false,
          },
          database,
        ),
        { saved: true },
      );
      // A continuation replaces the same message in place.
      await saveAgentRunMessages(
        {
          userId,
          conversationId,
          runId: firstRun,
          messages: [
            { id: assistantId, role: "assistant", parts: [{ type: "text", text: "Found it" }] },
          ],
          finishRun: true,
        },
        database,
      );
      const stored = await getAgentConversation({ userId, conversationId }, database);
      assert.deepEqual(stored?.messages, [
        firstMessage,
        { id: assistantId, role: "assistant", parts: [{ type: "text", text: "Found it" }] },
      ]);
      assert.equal(stored?.conversation.title, "Find the lease");
      assert.equal(await getAgentConversation({ userId: otherUserId, conversationId }, database), null);

      // A message ID from this conversation cannot be claimed by another one,
      // and the failed claim leaves no lease or conversation behind.
      const otherConversationId = uuidv4();
      await assert.rejects(
        startAgentRun(
          {
            userId,
            conversationId: otherConversationId,
            runId: uuidv4(),
            newMessage: { message: { ...firstMessage }, title: "Reused" },
          },
          database,
        ),
        AgentMessageConflictError,
      );
      assert.equal(
        await getAgentConversation({ userId, conversationId: otherConversationId }, database),
        null,
      );

      // An expired lease can be taken over, and the stale run is then fenced.
      const staleRun = uuidv4();
      await startAgentRun(
        {
          userId,
          conversationId,
          runId: staleRun,
          newMessage: { message: userMessage("Second turn"), title: "ignored" },
        },
        database,
      );
      await database
        .update(agentConversations)
        .set({ activeRunExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(agentConversations.id, conversationId));
      const takeoverRun = uuidv4();
      const takeover = await startAgentRun(
        { userId, conversationId, runId: takeoverRun, newMessage: null },
        database,
      );
      assert.equal(takeover.outcome, "started");
      assert.deepEqual(
        await saveAgentRunMessages(
          {
            userId,
            conversationId,
            runId: staleRun,
            messages: [{ id: uuidv4(), role: "assistant", parts: [{ type: "text", text: "Late" }] }],
            finishRun: true,
          },
          database,
        ),
        { saved: false },
      );

      const conversations = await listAgentConversations({ userId, limit: 30 }, database);
      assert.deepEqual(conversations.map((conversation) => conversation.id), [conversationId]);
      assert.deepEqual(await listAgentConversations({ userId: otherUserId, limit: 30 }, database), []);

      // Only the owner can delete, and deleting removes the copied history.
      assert.equal(
        await deleteAgentConversation({ userId: otherUserId, conversationId }, database),
        false,
      );
      assert.equal(await deleteAgentConversation({ userId, conversationId }, database), true);
      assert.equal(await getAgentConversation({ userId, conversationId }, database), null);
      assert.deepEqual(
        await database.select().from(schema.agentMessages).where(
          eq(schema.agentMessages.conversationId, conversationId),
        ),
        [],
      );
      // The superseded run can no longer store anything.
      assert.deepEqual(
        await saveAgentRunMessages(
          {
            userId,
            conversationId,
            runId: takeoverRun,
            messages: [{ id: uuidv4(), role: "assistant", parts: [{ type: "text", text: "Late" }] }],
            finishRun: true,
          },
          database,
        ),
        { saved: false },
      );
    } finally {
      await database.delete(profiles).where(inArray(profiles.id, [userId, otherUserId]));
      await client.end();
    }
  },
);

test(
  "a socket ticket redeems once, only before expiry, and only for a live session",
  { skip: !testDatabaseUrl },
  async () => {
    assert.ok(testDatabaseUrl);
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const userId = uuidv4();
    const sessionId = uuidv4();
    try {
      await database.insert(profiles).values({
        id: userId,
        displayName: "Ticket Owner",
        email: `${userId}@example.test`,
      });
      await database.insert(authSessions).values({
        id: sessionId,
        userId,
        token: uuidv4(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await createAgentSocketTicket(
        { tokenHash: "live", userId, sessionId, expiresAt: new Date(Date.now() + 60_000) },
        database,
      );
      await createAgentSocketTicket(
        { tokenHash: "expired", userId, sessionId, expiresAt: new Date(Date.now() - 1_000) },
        database,
      );

      assert.deepEqual(await consumeAgentSocketTicket({ tokenHash: "live" }, database), {
        userId,
        sessionId,
      });
      assert.equal(await consumeAgentSocketTicket({ tokenHash: "live" }, database), null);
      assert.equal(await consumeAgentSocketTicket({ tokenHash: "expired" }, database), null);

      assert.deepEqual(await getAgentSessionIdentity({ userId, sessionId }, database), {
        name: "Ticket Owner",
        email: `${userId}@example.test`,
      });
      assert.equal(
        await getAgentSessionIdentity({ userId: uuidv4(), sessionId }, database),
        null,
      );

      // Signing out deletes the session, which ends access and its tickets.
      await createAgentSocketTicket(
        { tokenHash: "after-sign-out", userId, sessionId, expiresAt: new Date(Date.now() + 60_000) },
        database,
      );
      await database.delete(authSessions).where(eq(authSessions.id, sessionId));
      assert.equal(await getAgentSessionIdentity({ userId, sessionId }, database), null);
      assert.equal(await consumeAgentSocketTicket({ tokenHash: "after-sign-out" }, database), null);
    } finally {
      await database.delete(profiles).where(eq(profiles.id, userId));
      await client.end();
    }
  },
);
