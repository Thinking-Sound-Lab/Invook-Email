import assert from "node:assert/strict";
import test from "node:test";

import { encryptGoogleCredential } from "@invook/database";

import {
  getGmailProviderAccess,
  getGmailProviderAccessForAccount,
} from "./gmail-provider";

const userId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";

test("a connected Gmail credential is usable without a replica-readiness gate", async () => {
  const previousEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  const encryptionKey = Buffer.alloc(32, 9).toString("base64");
  process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
  try {
    const result = await getGmailProviderAccess(userId, {
      getWriteContext: async () => ({
        userId,
        accountId,
        email: "owner@example.com",
        tokenCiphertext: encryptGoogleCredential(
          {
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: "2999-01-01T00:00:00.000Z",
            scopes: ["gmail.modify"],
          },
          encryptionKey,
        ),
      }),
    });

    assert.deepEqual(result, {
      status: "ready",
      access: {
        accessToken: "access-token",
        accountId,
        email: "owner@example.com",
      },
    });
  } finally {
    if (previousEncryptionKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
    }
  }
});

test("Gmail provider access remains unavailable without an owned connected context", async () => {
  const result = await getGmailProviderAccess(userId, {
    getWriteContext: async () => null,
  });

  assert.deepEqual(result, { status: "not_found", access: null });
});

test("Gmail provider access selects the requested owned account", async () => {
  const previousEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  const encryptionKey = Buffer.alloc(32, 9).toString("base64");
  process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
  try {
    let requestedContext: { userId: string; accountId: string } | null = null;
    const result = await getGmailProviderAccessForAccount(
      { userId, accountId },
      {
        getWriteContext: async (input) => {
          requestedContext = input;
          return {
            userId,
            accountId,
            email: "owner@example.com",
            tokenCiphertext: encryptGoogleCredential(
              {
                accessToken: "account-access-token",
                refreshToken: "refresh-token",
                expiresAt: "2999-01-01T00:00:00.000Z",
                scopes: ["gmail.modify"],
              },
              encryptionKey,
            ),
          };
        },
      },
    );

    assert.deepEqual(requestedContext, { userId, accountId });
    assert.deepEqual(result, {
      status: "ready",
      access: {
        accessToken: "account-access-token",
        accountId,
        email: "owner@example.com",
      },
    });
  } finally {
    if (previousEncryptionKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
    }
  }
});
