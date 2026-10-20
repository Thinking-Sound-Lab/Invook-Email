import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
} from "./schema";

/** The user and agent an MCP request's access token speaks for. */
export type McpAccessGrant = {
  userId: string;
  clientId: string;
  scopes: string[];
};

export type McpConnectionRecord = {
  clientId: string;
  name: string | null;
  connectedAt: Date;
  updatedAt: Date;
};

const isClientEnabled = or(
  isNull(oauthClients.disabled),
  eq(oauthClients.disabled, false),
);

/**
 * Resolves an MCP request's access token by its hash. The token must be
 * unexpired, issued to a user through an enabled client, and still backed by
 * that user's consent: revoking a connection deletes the consent in the same
 * transaction as the tokens, so a token minted by a code exchange that raced
 * the revocation is refused as well.
 */
export async function getMcpAccessGrant(
  input: { tokenHash: string },
  database: Database = getDatabase(),
): Promise<McpAccessGrant | null> {
  const [grant] = await database
    .select({
      userId: oauthConsents.userId,
      clientId: oauthAccessTokens.clientId,
      scopes: oauthAccessTokens.scopes,
    })
    .from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthAccessTokens.clientId))
    .innerJoin(
      oauthConsents,
      and(
        eq(oauthConsents.clientId, oauthAccessTokens.clientId),
        eq(oauthConsents.userId, oauthAccessTokens.userId),
      ),
    )
    .where(
      and(
        eq(oauthAccessTokens.token, input.tokenHash),
        gt(oauthAccessTokens.expiresAt, sql`now()`),
        isClientEnabled,
      ),
    )
    .limit(1);
  if (!grant?.userId) return null;
  return { userId: grant.userId, clientId: grant.clientId, scopes: grant.scopes };
}

/** Agents the user has authorized, most recently authorized first. */
export async function listMcpConnections(
  input: { userId: string },
  database: Database = getDatabase(),
): Promise<McpConnectionRecord[]> {
  return database
    .select({
      clientId: oauthConsents.clientId,
      name: oauthClients.name,
      connectedAt: oauthConsents.createdAt,
      updatedAt: oauthConsents.updatedAt,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .where(eq(oauthConsents.userId, input.userId))
    .orderBy(desc(oauthConsents.updatedAt), desc(oauthConsents.clientId));
}

/**
 * Disconnects one agent: its consent and every token it holds for this user
 * are deleted together, so its next MCP request is refused. The client
 * registration itself stays, because other users may share it.
 */
export async function revokeMcpConnection(
  input: { userId: string; clientId: string },
  database: Database = getDatabase(),
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const deletedConsents = await transaction
      .delete(oauthConsents)
      .where(
        and(
          eq(oauthConsents.userId, input.userId),
          eq(oauthConsents.clientId, input.clientId),
        ),
      )
      .returning({ id: oauthConsents.id });
    await transaction
      .delete(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.userId, input.userId),
          eq(oauthAccessTokens.clientId, input.clientId),
        ),
      );
    await transaction
      .delete(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.userId, input.userId),
          eq(oauthRefreshTokens.clientId, input.clientId),
        ),
      );
    return deletedConsents.length > 0;
  });
}
