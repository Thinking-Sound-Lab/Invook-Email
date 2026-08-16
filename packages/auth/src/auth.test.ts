import assert from "node:assert/strict";
import { test } from "node:test";

import { GOOGLE_IDENTITY_SCOPES, stripGlobalGoogleAccountTokens } from "./auth";

test("global Google authentication requests identity scopes only", () => {
  assert.deepEqual(GOOGLE_IDENTITY_SCOPES, ["openid", "email", "profile"]);
  assert.equal(
    GOOGLE_IDENTITY_SCOPES.some((scope) => scope.includes("gmail")),
    false,
  );
});

test("global Google authentication does not persist provider tokens or combined grants", () => {
  const account = stripGlobalGoogleAccountTokens({
    accountId: "google-account-id",
    providerId: "google",
    userId: "user-id",
    accessToken: "provider-access-token",
    refreshToken: "provider-refresh-token",
    idToken: "provider-id-token",
    accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    refreshTokenExpiresAt: new Date("2030-01-02T00:00:00.000Z"),
    scope: "openid https://www.googleapis.com/auth/gmail.modify",
  });

  assert.equal(account.accountId, "google-account-id");
  assert.equal(account.providerId, "google");
  assert.equal(account.userId, "user-id");
  assert.equal(account.accessToken, null);
  assert.equal(account.refreshToken, null);
  assert.equal(account.idToken, null);
  assert.equal(account.accessTokenExpiresAt, null);
  assert.equal(account.refreshTokenExpiresAt, null);
  assert.equal(account.scope, "openid,email,profile");
});
