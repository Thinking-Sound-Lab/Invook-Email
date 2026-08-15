import assert from "node:assert/strict";
import test from "node:test";

import * as databaseSchema from "@invook/database";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { createInvookAuth } from "./auth";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

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
        secret: "database-test-secret-at-least-32-characters",
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
        scope: "openid email profile",
      });
      assert.equal(account.userId, userId);
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
