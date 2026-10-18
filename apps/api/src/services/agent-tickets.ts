import { createHash, randomBytes } from "node:crypto";

import { AGENT_SOCKET_TICKET_PROTOCOL_PREFIX } from "@invook/contracts";
import {
  consumeAgentSocketTicket,
  createAgentSocketTicket,
} from "@invook/database";

/** Long enough to open a socket right after issuing, short enough to be useless later. */
const AGENT_SOCKET_TICKET_SECONDS = 60;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AgentTicketDependencies {
  createTicket: typeof createAgentSocketTicket;
  consumeTicket: typeof consumeAgentSocketTicket;
  now: () => Date;
}

const defaultDependencies: AgentTicketDependencies = {
  createTicket: createAgentSocketTicket,
  consumeTicket: consumeAgentSocketTicket,
  now: () => new Date(),
};

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export async function issueAgentSocketTicket(
  input: { userId: string; sessionId: string },
  dependencies: AgentTicketDependencies = defaultDependencies,
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    dependencies.now().getTime() + AGENT_SOCKET_TICKET_SECONDS * 1_000,
  );
  await dependencies.createTicket({
    tokenHash: hashTicket(ticket),
    userId: input.userId,
    sessionId: input.sessionId,
    expiresAt,
  });
  return { ticket, expiresAt };
}

/** Reads the ticket a browser offered as a `Sec-WebSocket-Protocol` value. */
export function readAgentSocketTicket(
  protocolHeader: string | string[] | undefined,
): string | null {
  const values = (Array.isArray(protocolHeader)
    ? protocolHeader
    : [protocolHeader ?? ""]
  ).flatMap((value) => value.split(","));
  const tickets = values
    .map((value) => value.trim())
    .filter((value) => value.startsWith(AGENT_SOCKET_TICKET_PROTOCOL_PREFIX))
    .map((value) => value.slice(AGENT_SOCKET_TICKET_PROTOCOL_PREFIX.length));
  if (tickets.length !== 1) return null;
  const [ticket] = tickets;
  return ticket && TICKET_PATTERN.test(ticket) ? ticket : null;
}

export async function redeemAgentSocketTicket(
  ticket: string,
  dependencies: AgentTicketDependencies = defaultDependencies,
): Promise<{ userId: string; sessionId: string } | null> {
  return dependencies.consumeTicket({ tokenHash: hashTicket(ticket) });
}
