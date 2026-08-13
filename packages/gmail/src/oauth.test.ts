import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import axios from "axios";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { verifyGoogleIdToken } from "./oauth";

const audience = "https://api.example.test/gmail/pubsub";
const serviceAccountEmail = "gmail-push@example.iam.gserviceaccount.com";
const keyId = "google-protocol-test-key";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = {
  ...(await exportJWK(publicKey)),
  alg: "RS256",
  kid: keyId,
  use: "sig",
};
const originalAxiosGet = axios.get;

before(() => {
  axios.get = (async (url: string) => {
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
    return { data: { keys: [publicJwk] } };
  }) as typeof axios.get;
});

after(() => {
  axios.get = originalAxiosGet;
});

async function signedGoogleToken(options?: {
  audience?: string;
  emailVerified?: boolean;
  expiresInSeconds?: number;
  includeExpiration?: boolean;
  issuer?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT({
    email: serviceAccountEmail,
    email_verified: options?.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(options?.issuer ?? "https://accounts.google.com")
    .setAudience(options?.audience ?? audience)
    .setSubject("service-account-subject")
    .setIssuedAt(now);
  if (options?.includeExpiration !== false) {
    token = token.setExpirationTime(now + (options?.expiresInSeconds ?? 300));
  }
  return token.sign(privateKey);
}

test("Google ID token verification returns authenticated OIDC claims", async () => {
  const claims = await verifyGoogleIdToken(await signedGoogleToken(), audience);

  assert.equal(claims.sub, "service-account-subject");
  assert.equal(claims.email, serviceAccountEmail);
  assert.equal(claims.email_verified, true);
  assert.equal(claims.iss, "https://accounts.google.com");
  assert.equal(claims.aud, audience);
  assert.equal(typeof claims.exp, "number");
});

test("Google ID token verification rejects a different push audience", async () => {
  await assert.rejects(
    verifyGoogleIdToken(
      await signedGoogleToken({ audience: "https://wrong.example.test/push" }),
      audience,
    ),
    /aud|audience/i,
  );
});

test("Google ID token verification rejects a non-Google issuer", async () => {
  await assert.rejects(
    verifyGoogleIdToken(
      await signedGoogleToken({ issuer: "https://identity.example.test" }),
      audience,
    ),
    /iss|issuer/i,
  );
});

test("Google ID token verification rejects an expired token", async () => {
  await assert.rejects(
    verifyGoogleIdToken(
      await signedGoogleToken({ expiresInSeconds: -60 }),
      audience,
    ),
    /exp|expired/i,
  );
});

test("Google ID token verification requires an expiration claim", async () => {
  await assert.rejects(
    verifyGoogleIdToken(
      await signedGoogleToken({ includeExpiration: false }),
      audience,
    ),
    /complete verified identity token/,
  );
});

test("Google ID token verification requires a verified email", async () => {
  await assert.rejects(
    verifyGoogleIdToken(
      await signedGoogleToken({ emailVerified: false }),
      audience,
    ),
    /complete verified identity token/,
  );
});
