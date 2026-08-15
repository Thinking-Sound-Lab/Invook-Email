import assert from "node:assert/strict";
import { test } from "node:test";

import { assertIdentityOnlyGoogleScope, GOOGLE_IDENTITY_SCOPES } from "./auth";

test("global Google authentication requests identity scopes only", () => {
  assert.deepEqual(GOOGLE_IDENTITY_SCOPES, ["openid", "email", "profile"]);
  assert.equal(
    GOOGLE_IDENTITY_SCOPES.some((scope) => scope.includes("gmail")),
    false,
  );
});

test("global Google authentication rejects non-identity token scopes", () => {
  assert.doesNotThrow(() =>
    assertIdentityOnlyGoogleScope(
      "openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/userinfo.profile",
    ),
  );
  assert.throws(
    () =>
      assertIdentityOnlyGoogleScope(
        "openid https://www.googleapis.com/auth/gmail.modify",
      ),
    /non-identity scope/,
  );
});
