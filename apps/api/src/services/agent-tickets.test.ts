import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AGENT_SOCKET_TICKET_PROTOCOL_PREFIX } from "@invook/contracts";

import {
  issueAgentSocketTicket,
  readAgentSocketTicket,
  redeemAgentSocketTicket,
  type AgentTicketDependencies,
} from "./agent-tickets";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "99999999-9999-4999-8999-999999999999";

function memoryTickets() {
  const stored = new Map<string, { userId: string; sessionId: string; expiresAt: Date }>();
  const dependencies: AgentTicketDependencies = {
    now: () => new Date("2026-10-18T09:00:00.000Z"),
    createTicket: async ({ tokenHash, ...ticket }) => {
      stored.set(tokenHash, ticket);
    },
    consumeTicket: async ({ tokenHash }) => {
      const ticket = stored.get(tokenHash);
      stored.delete(tokenHash);
      return ticket ? { userId: ticket.userId, sessionId: ticket.sessionId } : null;
    },
  };
  return { stored, dependencies };
}

test("a ticket is stored only by hash, expires in a minute, and redeems once", async () => {
  const { stored, dependencies } = memoryTickets();

  const { ticket, expiresAt } = await issueAgentSocketTicket(
    { userId, sessionId },
    dependencies,
  );

  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt.toISOString(), "2026-10-18T09:01:00.000Z");
  assert.deepEqual([...stored.keys()], [
    createHash("sha256").update(ticket).digest("hex"),
  ]);
  assert.equal(stored.has(ticket), false);
  assert.deepEqual(await redeemAgentSocketTicket(ticket, dependencies), {
    userId,
    sessionId,
  });
  assert.equal(await redeemAgentSocketTicket(ticket, dependencies), null);
});

test("the ticket is read from exactly one offered ticket subprotocol", () => {
  const ticket = "A".repeat(43);
  const offered = `${AGENT_SOCKET_TICKET_PROTOCOL_PREFIX}${ticket}`;

  assert.equal(readAgentSocketTicket(`invook.agent.v1, ${offered}`), ticket);
  assert.equal(readAgentSocketTicket(["invook.agent.v1", offered]), ticket);
  assert.equal(readAgentSocketTicket("invook.agent.v1"), null);
  assert.equal(readAgentSocketTicket(undefined), null);
  assert.equal(readAgentSocketTicket(`${offered}, ${offered}`), null);
  assert.equal(
    readAgentSocketTicket(`${AGENT_SOCKET_TICKET_PROTOCOL_PREFIX}${"A".repeat(42)}!`),
    null,
  );
});
