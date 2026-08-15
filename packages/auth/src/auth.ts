import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { v4 as uuidv4 } from "uuid";

import {
  authAccounts,
  authSessions,
  authVerifications,
  getDatabase,
  profiles,
  type Database,
} from "@invook/database";

export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

const GOOGLE_IDENTITY_TOKEN_SCOPES = new Set([
  ...GOOGLE_IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);

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

export function assertIdentityOnlyGoogleScope(scope: string | null | undefined): void {
  if (!scope) return;
  const unexpectedScope = scope
    .split(/[\s,]+/)
    .find((value) => value && !GOOGLE_IDENTITY_TOKEN_SCOPES.has(value));
  if (unexpectedScope) {
    throw new Error("Global Google authentication returned a non-identity scope.");
  }
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
    basePath: "/v1/auth",
    secret,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        profiles,
        authAccounts,
        authSessions,
        authVerifications,
      },
      transaction: true,
    }),
    advanced: {
      cookiePrefix: "invook",
      database: { generateId: () => uuidv4() },
      useSecureCookies: appUrl.protocol === "https:",
    },
    disabledPaths: ["/link-social"],
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
    databaseHooks: {
      account: {
        create: {
          before: async (account) => {
            assertIdentityOnlyGoogleScope(account.scope);
          },
        },
        update: {
          before: async (account) => {
            assertIdentityOnlyGoogleScope(account.scope);
          },
        },
      },
    },
  });
}

export type InvookAuth = ReturnType<typeof createInvookAuth>;
