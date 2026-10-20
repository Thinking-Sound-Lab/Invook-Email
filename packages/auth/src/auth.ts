import { betterAuth, type Account } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { v4 as uuidv4 } from "uuid";

import {
  authAccounts,
  authSessions,
  authVerifications,
  getDatabase,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  profiles,
  type Database,
} from "@invook/database";

import {
  createMcpAuthorizationServer,
  UNUSED_OAUTH_PROVIDER_PATHS,
} from "./mcp-authorization";

export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

/** Where Better Auth's routes live on the application origin. */
export const AUTH_BASE_PATH = "/v1/auth";

/**
 * The OAuth issuer of Invook's MCP authorization server: Better Auth's base
 * URL. Agents find its metadata at /.well-known/oauth-authorization-server
 * followed by this path (RFC 8414).
 */
export function getAuthorizationServerIssuer(appOrigin: string): string {
  return `${new URL(appOrigin).origin}${AUTH_BASE_PATH}`;
}

const GOOGLE_IDENTITY_ACCOUNT_SCOPE = GOOGLE_IDENTITY_SCOPES.join(",");

/**
 * How long a signed cookie vouches for a session before the database is asked
 * again. A session revoked elsewhere keeps working for at most this long;
 * signing out in the browser clears the cookie immediately.
 */
const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

export interface InvookAuthConfiguration {
  appUrl: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

function requireConfigurationValue(value: string, name: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) throw new Error(`${name} is required by @invook/auth.`);
  return normalizedValue;
}

export function stripGlobalGoogleAccountTokens(
  account: Partial<Account> & Record<string, unknown>,
): Partial<Account> & Record<string, unknown> {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: GOOGLE_IDENTITY_ACCOUNT_SCOPE,
  };
}

export function createInvookAuth(
  configuration: InvookAuthConfiguration,
  database: Database = getDatabase(),
) {
  const appUrl = new URL(
    requireConfigurationValue(configuration.appUrl, "APP_URL"),
  );
  if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTP or HTTPS.");
  }

  const secret = requireConfigurationValue(
    configuration.secret,
    "BETTER_AUTH_SECRET",
  );
  const googleClientId = requireConfigurationValue(
    configuration.googleClientId,
    "BETTER_AUTH_GOOGLE_CLIENT_ID",
  );
  const googleClientSecret = requireConfigurationValue(
    configuration.googleClientSecret,
    "BETTER_AUTH_GOOGLE_CLIENT_SECRET",
  );

  return betterAuth({
    appName: "Invook",
    baseURL: appUrl.origin,
    basePath: AUTH_BASE_PATH,
    secret,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        profiles,
        authAccounts,
        authSessions,
        authVerifications,
        oauthClients,
        oauthRefreshTokens,
        oauthAccessTokens,
        oauthConsents,
      },
      transaction: true,
    }),
    advanced: {
      cookiePrefix: "invook",
      database: { generateId: () => uuidv4() },
      useSecureCookies: appUrl.protocol === "https:",
    },
    disabledPaths: ["/link-social", ...UNUSED_OAUTH_PROVIDER_PATHS],
    trustedOrigins: [appUrl.origin],
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        accessType: "online",
        prompt: "select_account",
        disableDefaultScope: true,
        scope: [...GOOGLE_IDENTITY_SCOPES],
      },
    },
    user: {
      modelName: "profiles",
      fields: { name: "displayName" },
    },
    session: {
      modelName: "authSessions",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
    },
    account: {
      modelName: "authAccounts",
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      accountLinking: {
        enabled: false,
        allowDifferentEmails: false,
      },
    },
    verification: { modelName: "authVerifications" },
    plugins: [createMcpAuthorizationServer(appUrl.origin)],
    databaseHooks: {
      account: {
        create: {
          before: async (account) => {
            return { data: stripGlobalGoogleAccountTokens(account) };
          },
        },
        update: {
          before: async (account) => {
            return { data: stripGlobalGoogleAccountTokens(account) };
          },
        },
      },
    },
  });
}

export type InvookAuth = ReturnType<typeof createInvookAuth>;
