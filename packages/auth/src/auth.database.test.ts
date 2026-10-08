import assert from "node:assert/strict";
import test from "node:test";

import * as databaseSchema from "@invook/database";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { createInvookAuth } from "./auth";
import { getInvookSession } from "./session";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testSecret = "database-test-secret-at-least-32-characters";
const sessionTokenCookieName = "invook.session_token";
const sessionCacheCookieName = "invook.session_data";

/** Signs a stored session token the way Better Auth signs the browser cookie. */
async function createSessionTokenCookie(token: string): Promise<string> {
  const signature = await makeSignature(token, testSecret);
  return `${sessionTokenCookieName}=${encodeURIComponent(`${token}.${signature}`)}`;
}

/** Rewrites the cached user while keeping the original signature. */
function forgeSessionCacheUser(sessionCacheCookie: string | undefined): string {
  assert.ok(sessionCacheCookie);
  const encodedPayload = decodeURIComponent(
    sessionCacheCookie.slice(`${sessionCacheCookieName}=`.length),
  );
  const payload: unknown = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  const forgedPayload = JSON.stringify(payload).replaceAll(
    "Cookie Cache Database Test",
    "Forged Cookie Cache User",
  );
  assert.notEqual(forgedPayload, JSON.stringify(payload));
  return `${sessionCacheCookieName}=${Buffer.from(forgedPayload, "utf8").toString("base64url")}`;
}

function findSetCookie(setCookies: string[], name: string): string | undefined {
  return setCookies.find((setCookie) => setCookie.startsWith(`${name}=`));
}

function assertCookieRemoved(setCookies: string[], name: string): void {
  const setCookie = findSetCookie(setCookies, name);
  assert.ok(setCookie, `${name} must be removed`);
  assert.match(setCookie, new RegExp(`^${name.replace(".", "\\.")}=;`));
  assert.match(setCookie, /Max-Age=0/i);
}

test(
  "Better Auth owns users, Google identities, sessions, and verification state",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const databaseClient = postgres(testDatabaseUrl, {
      max: 1,
      prepare: false,
    });
    const database = drizzle(databaseClient, { schema: databaseSchema });
    const auth = createInvookAuth(
      {
        appUrl: "http://localhost:3000",
        secret: testSecret,
        googleClientId: "database-test-client-id",
        googleClientSecret: "database-test-client-secret",
      },
      database,
    );
    const adapter = (await auth.$context).internalAdapter;
    const identitySuffix = uuidv4();
    const email = `auth-${identitySuffix}@example.test`;
    const providerAccountId = `google-${identitySuffix}`;
    const verificationIdentifier = `oauth-state-${identitySuffix}`;
    let userId: string | null = null;

    try {
      const user = await adapter.createUser({
        name: "Better Auth Database Test",
        email,
        image: null,
      });
      userId = user.id;
      assert.equal(user.email, email);

      const account = await adapter.createAccount({
        accountId: providerAccountId,
        providerId: "google",
        userId,
        accessToken: "combined-provider-access-token",
        refreshToken: "combined-provider-refresh-token",
        idToken: "combined-provider-id-token",
        accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        refreshTokenExpiresAt: new Date("2030-01-02T00:00:00.000Z"),
        scope: "openid https://www.googleapis.com/auth/gmail.modify",
      });
      assert.equal(account.userId, userId);
      assert.equal(account.accessToken, null);
      assert.equal(account.refreshToken, null);
      assert.equal(account.idToken, null);
      assert.equal(account.accessTokenExpiresAt, null);
      assert.equal(account.refreshTokenExpiresAt, null);
      assert.equal(account.scope, "openid,email,profile");
      assert.equal(
        (await adapter.findOAuthUser(email, providerAccountId, "google"))?.user.id,
        userId,
      );

      const session = await adapter.createSession(userId);
      assert.equal((await adapter.findSession(session.token))?.user.id, userId);
      await adapter.deleteSession(session.token);
      assert.equal(await adapter.findSession(session.token), null);

      await adapter.createVerificationValue({
        identifier: verificationIdentifier,
        value: "hashed-oauth-state",
        expiresAt: new Date(Date.now() + 60_000),
      });
      assert.equal(
        (await adapter.findVerificationValue(verificationIdentifier))?.value,
        "hashed-oauth-state",
      );
      await adapter.deleteVerificationByIdentifier(verificationIdentifier);
      assert.equal(
        await adapter.findVerificationValue(verificationIdentifier),
        null,
      );
    } finally {
      await adapter.deleteVerificationByIdentifier(verificationIdentifier);
      if (userId) await adapter.deleteUser(userId);
      await databaseClient.end();
    }
  },
);

test(
  "the session cookie cache answers without the database for five minutes and no longer",
  { skip: !testDatabaseUrl },
  async (context) => {
    if (!testDatabaseUrl) return;
    const databaseClient = postgres(testDatabaseUrl, {
      max: 1,
      prepare: false,
    });
    const database = drizzle(databaseClient, { schema: databaseSchema });
    const auth = createInvookAuth(
      {
        appUrl: "http://localhost:3000",
        secret: testSecret,
        googleClientId: "database-test-client-id",
        googleClientSecret: "database-test-client-secret",
      },
      database,
    );
    const adapter = (await auth.$context).internalAdapter;
    let userId: string | null = null;

    try {
      const user = await adapter.createUser({
        name: "Cookie Cache Database Test",
        email: `auth-cache-${uuidv4()}@example.test`,
        image: null,
      });
      userId = user.id;
      const session = await adapter.createSession(userId);
      const sessionTokenCookie = await createSessionTokenCookie(session.token);

      const fromDatabase = await getInvookSession(
        auth,
        new Headers({ cookie: sessionTokenCookie }),
      );
      assert.equal(fromDatabase.session?.userId, userId);
      const cacheSetCookie = findSetCookie(
        fromDatabase.setCookies,
        sessionCacheCookieName,
      );
      assert.ok(cacheSetCookie, "a database read must issue the cookie cache");
      assert.match(cacheSetCookie, /Max-Age=300(;|$)/i);
      assert.match(cacheSetCookie, /HttpOnly/i);
      assert.match(cacheSetCookie, /SameSite=Lax/i);
      const [sessionCacheCookie] = cacheSetCookie.split(";");
      const browserCookies = `${sessionTokenCookie}; ${sessionCacheCookie}`;

      // Revoking the row while the browser still holds a fresh cache is the
      // accepted window: the session answers without a database read.
      await adapter.deleteSession(session.token);
      const fromCache = await getInvookSession(
        auth,
        new Headers({ cookie: browserCookies }),
      );
      assert.equal(fromCache.session?.userId, userId);
      assert.deepEqual(fromCache.setCookies, []);

      const forgedCache = await getInvookSession(
        auth,
        new Headers({
          cookie: `${sessionTokenCookie}; ${forgeSessionCacheUser(sessionCacheCookie)}`,
        }),
      );
      assert.equal(forgedCache.session, null);

      context.mock.timers.enable({
        apis: ["Date"],
        now: Date.now() + 5 * 60 * 1_000 + 1_000,
      });
      const afterCacheLifetime = await getInvookSession(
        auth,
        new Headers({ cookie: browserCookies }),
      );
      context.mock.timers.reset();
      assert.equal(afterCacheLifetime.session, null);
      assertCookieRemoved(afterCacheLifetime.setCookies, sessionTokenCookieName);
      assertCookieRemoved(afterCacheLifetime.setCookies, sessionCacheCookieName);
    } finally {
      context.mock.timers.reset();
      if (userId) await adapter.deleteUser(userId);
      await databaseClient.end();
    }
  },
);

test(
  "signing out removes the session cookie cache with the session",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const databaseClient = postgres(testDatabaseUrl, {
      max: 1,
      prepare: false,
    });
    const database = drizzle(databaseClient, { schema: databaseSchema });
    const auth = createInvookAuth(
      {
        appUrl: "http://localhost:3000",
        secret: testSecret,
        googleClientId: "database-test-client-id",
        googleClientSecret: "database-test-client-secret",
      },
      database,
    );
    const adapter = (await auth.$context).internalAdapter;
    let userId: string | null = null;

    try {
      const user = await adapter.createUser({
        name: "Cookie Cache Sign-Out Test",
        email: `auth-sign-out-${uuidv4()}@example.test`,
        image: null,
      });
      userId = user.id;
      const session = await adapter.createSession(userId);
      const sessionTokenCookie = await createSessionTokenCookie(session.token);
      const resolved = await getInvookSession(
        auth,
        new Headers({ cookie: sessionTokenCookie }),
      );
      const cacheSetCookie = findSetCookie(
        resolved.setCookies,
        sessionCacheCookieName,
      );
      assert.ok(cacheSetCookie, "a database read must issue the cookie cache");
      const [sessionCacheCookie] = cacheSetCookie.split(";");

      const response = await auth.handler(
        new Request("http://localhost:3000/v1/auth/sign-out", {
          method: "POST",
          headers: {
            cookie: `${sessionTokenCookie}; ${sessionCacheCookie}`,
            origin: "http://localhost:3000",
          },
        }),
      );
      assert.equal(response.status, 200);
      const signOutCookies = response.headers.getSetCookie();
      assertCookieRemoved(signOutCookies, sessionTokenCookieName);
      assertCookieRemoved(signOutCookies, sessionCacheCookieName);
      assert.equal(await adapter.findSession(session.token), null);
    } finally {
      if (userId) await adapter.deleteUser(userId);
      await databaseClient.end();
    }
  },
);
