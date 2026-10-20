import { createHash } from "node:crypto";

import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
} from "@better-auth/oauth-provider";

import {
  MCP_CONSENT_PATH,
  MCP_MAIL_SCOPE,
  MCP_OFFLINE_ACCESS_SCOPE,
  MCP_PATH,
  SIGN_IN_PATH,
} from "@invook/contracts";

/**
 * OAuth provider endpoints Invook does not use. Agents register through
 * dynamic registration, and people manage connected agents through Invook's
 * own routes, so the plugin's client and consent management APIs, OpenID
 * endpoints, and introspection stay unreachable over HTTP.
 */
export const UNUSED_OAUTH_PROVIDER_PATHS = [
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/update-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/delete-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  "/oauth2/introspect",
  "/oauth2/userinfo",
  "/oauth2/end-session",
] as const;

/** The canonical resource identifier agents request tokens for (RFC 8707). */
export function getMcpResourceUrl(appOrigin: string): string {
  return `${new URL(appOrigin).origin}${MCP_PATH}`;
}

/**
 * Access tokens, refresh tokens, and authorization codes are stored only as
 * this digest. The MCP server hashes a presented bearer token the same way to
 * find it.
 */
export function hashOAuthToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Invook's authorization server for MCP clients. Agents register themselves
 * as public PKCE clients, every user approves each agent on the consent page,
 * and tokens are opaque, so deleting a row revokes access immediately.
 */
export function createMcpAuthorizationServer(appOrigin: string) {
  return oauthProvider({
    loginPage: SIGN_IN_PATH,
    consentPage: MCP_CONSENT_PATH,
    scopes: [MCP_MAIL_SCOPE, MCP_OFFLINE_ACCESS_SCOPE],
    validAudiences: [getMcpResourceUrl(appOrigin)],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    disableJwtPlugin: true,
    storeTokens: { hash: (token) => hashOAuthToken(token) },
    // The API serves the root metadata document that clients discover.
    silenceWarnings: { oauthAuthServerConfig: true },
    schema: {
      oauthClient: { modelName: "oauthClients" },
      oauthRefreshToken: { modelName: "oauthRefreshTokens" },
      oauthAccessToken: { modelName: "oauthAccessTokens" },
      oauthConsent: { modelName: "oauthConsents" },
    },
  });
}

/** Metadata the plugin always lists for endpoints Invook keeps unreachable. */
const UNAVAILABLE_ENDPOINT_METADATA = new Set([
  "introspection_endpoint",
  "introspection_endpoint_auth_methods_supported",
]);

/**
 * Serves RFC 8414 authorization server metadata for the plugin's issuer,
 * without advertising endpoints listed in {@link UNUSED_OAUTH_PROVIDER_PATHS}.
 */
export async function getAuthorizationServerMetadataResponse(
  auth: Parameters<typeof oauthProviderAuthServerMetadata>[0],
  request: Request,
): Promise<Response> {
  const response = await oauthProviderAuthServerMetadata(auth)(request);
  const metadata: unknown = await response.json();
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("Authorization server metadata must be a JSON object.");
  }
  return Response.json(
    Object.fromEntries(
      Object.entries(metadata).filter(([name]) => !UNAVAILABLE_ENDPOINT_METADATA.has(name)),
    ),
    { status: response.status, headers: response.headers },
  );
}
