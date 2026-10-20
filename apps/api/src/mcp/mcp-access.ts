import type { AuthInfo } from "@modelcontextprotocol/server";

import { MCP_MAIL_SCOPE, MCP_OFFLINE_ACCESS_SCOPE, MCP_PATH } from "@invook/contracts";

import type { McpIdentity } from "./mcp-server";

/** RFC 6750 token68 syntax, bounded well above the plugin's 32-character tokens. */
const BEARER_TOKEN_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]{1,512}=*)$/i;

/**
 * Scopes an agent requests. `offline_access` is advertised with the resource
 * scope, against the MCP spec's suggestion, because clients only ask for the
 * scopes they are shown and Invook issues refresh tokens only for it; without
 * one, every connected agent would have to sign in again each hour.
 */
export const MCP_REQUESTED_SCOPES = [MCP_MAIL_SCOPE, MCP_OFFLINE_ACCESS_SCOPE] as const;

export function getProtectedResourceMetadataUrl(appOrigin: string): string {
  return `${new URL(appOrigin).origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** RFC 9728 metadata that points agents at Invook's authorization server. */
export function buildProtectedResourceMetadata(input: {
  resource: string;
  issuer: string;
}) {
  return {
    resource: input.resource,
    authorization_servers: [input.issuer],
    scopes_supported: [...MCP_REQUESTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Invook",
  };
}

/** Reads the access token from an `Authorization: Bearer` header, if well formed. */
export function readBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  return BEARER_TOKEN_PATTERN.exec(header.trim())?.[1] ?? null;
}

/** The `WWW-Authenticate` challenge that starts or repeats an agent's sign-in. */
export function buildBearerChallenge(input: {
  resourceMetadataUrl: string;
  error?: "invalid_token" | "insufficient_scope";
}): string {
  const parameters = [
    ...(input.error ? [`error="${input.error}"`] : []),
    `resource_metadata="${input.resourceMetadataUrl}"`,
    `scope="${MCP_REQUESTED_SCOPES.join(" ")}"`,
  ];
  return `Bearer ${parameters.join(", ")}`;
}

/** Carries a verified grant into the MCP SDK, which passes it through untouched. */
export function toMcpAuthInfo(input: {
  token: string;
  identity: McpIdentity;
  scopes: string[];
}): AuthInfo {
  return {
    token: input.token,
    clientId: input.identity.clientId,
    scopes: input.scopes,
    extra: { userId: input.identity.userId },
  };
}

/** Recovers the identity {@link toMcpAuthInfo} attached to a request. */
export function readMcpIdentity(authInfo: AuthInfo | undefined): McpIdentity | null {
  const userId = authInfo?.extra?.userId;
  if (!authInfo || typeof userId !== "string") return null;
  return { userId, clientId: authInfo.clientId };
}
