import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import * as databaseSchema from "@invook/database";
import {
  getMcpAccessGrant,
  listMcpConnections,
  revokeMcpConnection,
} from "@invook/database";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { createInvookAuth } from "./auth";
import {
  getAuthorizationServerMetadataResponse,
  hashOAuthToken,
} from "./mcp-authorization";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testSecret = "database-test-secret-at-least-32-characters";
const appOrigin = "http://localhost:3000";
const resource = `${appOrigin}/mcp`;
const redirectUri = "http://127.0.0.1:33418/callback";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  scope: string;
  token_type: string;
};

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

test(
  "an agent connects only after consent, holds hashed tokens, and is cut off by revocation",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const databaseClient = postgres(testDatabaseUrl, { max: 2, prepare: false });
    const database = drizzle(databaseClient, { schema: databaseSchema });
    const auth = createInvookAuth(
      {
        appUrl: appOrigin,
        secret: testSecret,
        googleClientId: "database-test-client-id",
        googleClientSecret: "database-test-client-secret",
      },
      database,
    );
    const adapter = (await auth.$context).internalAdapter;
    const call = (path: string, init: RequestInit = {}) =>
      auth.handler(new Request(`${appOrigin}${path}`, init));
    let userId: string | null = null;
    const clientIds: string[] = [];

    try {
      const user = await adapter.createUser({
        name: "MCP Authorization Test",
        email: `mcp-${uuidv4()}@example.test`,
        image: null,
      });
      userId = user.id;
      const session = await adapter.createSession(user.id);
      const signature = await makeSignature(session.token, testSecret);
      const cookie = `invook.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;

      // An agent discovers the server and registers itself without credentials.
      const metadataResponse = await getAuthorizationServerMetadataResponse(
        auth,
        new Request(`${appOrigin}/.well-known/oauth-authorization-server/v1/auth`),
      );
      const metadata = (await metadataResponse.json()) as Record<string, unknown>;
      assert.equal(metadata.issuer, `${appOrigin}/v1/auth`);
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
      assert.equal(metadata.authorization_response_iss_parameter_supported, true);
      assert.equal(metadata.registration_endpoint, `${appOrigin}/v1/auth/oauth2/register`);
      assert.equal(metadata.introspection_endpoint, undefined);
      assert.equal(metadata.revocation_endpoint, `${appOrigin}/v1/auth/oauth2/revoke`);

      const registration = await call("/v1/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Agent",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
          scope: "mail offline_access",
        }),
      });
      // Better Auth answers 200 rather than RFC 7591's 201; clients accept any 2xx.
      assert.ok(registration.ok);
      const client = (await registration.json()) as {
        client_id: string;
        client_secret?: string;
        token_endpoint_auth_method: string;
      };
      clientIds.push(client.client_id);
      assert.equal(client.token_endpoint_auth_method, "none");
      assert.equal(client.client_secret, undefined);

      // A signed-in person is sent to the consent page; no code is issued yet.
      const pkce = createPkce();
      const authorizeQuery = new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: "mail offline_access",
        state: "agent-state",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        resource,
      });
      const authorize = await call(`/v1/auth/oauth2/authorize?${authorizeQuery}`, {
        headers: { cookie },
      });
      assert.equal(authorize.status, 302);
      const consentLocation = new URL(authorize.headers.get("location") ?? "", appOrigin);
      assert.equal(consentLocation.pathname, "/oauth/consent");
      assert.equal(consentLocation.searchParams.get("client_id"), client.client_id);
      assert.ok(consentLocation.searchParams.get("sig"));
      assert.equal(consentLocation.searchParams.get("code"), null);

      // A signed-out browser is sent to sign in first, carrying the signed request.
      const signedOut = await call(`/v1/auth/oauth2/authorize?${authorizeQuery}`);
      const signInLocation = new URL(signedOut.headers.get("location") ?? "", appOrigin);
      assert.equal(signInLocation.pathname, "/sign-in");
      assert.ok(signInLocation.searchParams.get("sig"));

      // Google sign-in carries the signed request so Invook can resume it.
      const signIn = (oauthQuery: string) =>
        call("/v1/auth/sign-in/social", {
          method: "POST",
          headers: { origin: appOrigin, "content-type": "application/json" },
          body: JSON.stringify({
            provider: "google",
            callbackURL: "/sign-in",
            oauth_query: oauthQuery,
          }),
        });
      const resumable = await signIn(signInLocation.search.slice(1));
      assert.equal(resumable.status, 200);
      const googleRedirect = new URL(((await resumable.json()) as { url: string }).url);
      assert.equal(googleRedirect.host, "accounts.google.com");
      const forgedSignIn = new URLSearchParams(signInLocation.search);
      forgedSignIn.set("client_id", "someOtherClient");
      assert.equal((await signIn(forgedSignIn.toString())).status, 400);

      // A forged consent query is refused.
      const tamperedQuery = new URLSearchParams(consentLocation.search);
      tamperedQuery.set("redirect_uri", "https://attacker.example/callback");
      const tampered = await call("/v1/auth/oauth2/consent", {
        method: "POST",
        headers: { cookie, origin: appOrigin, "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: tamperedQuery.toString() }),
      });
      assert.equal(tampered.status, 400);

      const consent = await call("/v1/auth/oauth2/consent", {
        method: "POST",
        headers: { cookie, origin: appOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          accept: true,
          oauth_query: consentLocation.search.slice(1),
        }),
      });
      assert.equal(consent.status, 200);
      const consentResult = (await consent.json()) as { url: string };
      const callback = new URL(consentResult.url);
      assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
      assert.equal(callback.searchParams.get("state"), "agent-state");
      assert.equal(callback.searchParams.get("iss"), `${appOrigin}/v1/auth`);
      const code = callback.searchParams.get("code");
      assert.ok(code);

      const exchange = await call("/v1/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: pkce.verifier,
          resource,
        }),
      });
      assert.equal(exchange.status, 200);
      const tokens = (await exchange.json()) as TokenResponse;
      assert.equal(tokens.scope, "mail offline_access");
      assert.ok(tokens.refresh_token);

      // The token authorizes MCP requests and is stored only as a digest.
      assert.deepEqual(
        await getMcpAccessGrant({ tokenHash: hashOAuthToken(tokens.access_token) }, database),
        { userId, clientId: client.client_id, scopes: ["mail", "offline_access"] },
      );
      const storedTokens = await database
        .select({ token: databaseSchema.oauthAccessTokens.token })
        .from(databaseSchema.oauthAccessTokens)
        .where(eq(databaseSchema.oauthAccessTokens.clientId, client.client_id));
      assert.deepEqual(storedTokens, [{ token: hashOAuthToken(tokens.access_token) }]);

      // A code is single use.
      const replayed = await call("/v1/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: pkce.verifier,
          resource,
        }),
      });
      assert.notEqual(replayed.status, 200);

      const refresh = (refreshToken: string, tokenResource = resource) =>
        call("/v1/auth/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: client.client_id,
            resource: tokenResource,
          }),
        });
      const grantFor = (token: string) =>
        getMcpAccessGrant({ tokenHash: hashOAuthToken(token) }, database);

      // Tokens for another resource are never issued, and asking does not
      // spend the refresh token.
      const otherResource = await refresh(tokens.refresh_token, "https://attacker.example/mcp");
      assert.equal(otherResource.status, 400);
      assert.match(await otherResource.text(), /requested resource invalid/);

      // Refreshing rotates the refresh token.
      const refreshed = await refresh(tokens.refresh_token);
      assert.equal(refreshed.status, 200);
      const rotated = (await refreshed.json()) as TokenResponse;
      assert.ok(rotated.refresh_token);
      assert.notEqual(rotated.refresh_token, tokens.refresh_token);

      // Signing out of the website ends the browser session, not the agent.
      await adapter.deleteSession(session.token);
      const afterSignOut = await refresh(rotated.refresh_token);
      assert.equal(afterSignOut.status, 200);
      const stillConnected = (await afterSignOut.json()) as TokenResponse;
      assert.ok(stillConnected.refresh_token);
      assert.ok(await grantFor(stillConnected.access_token));

      // Replaying a spent refresh token, as a thief would, revokes the family.
      assert.notEqual((await refresh(tokens.refresh_token)).status, 200);
      assert.equal(await grantFor(stillConnected.access_token), null);
      assert.notEqual((await refresh(stillConnected.refresh_token)).status, 200);

      // The person's consent is remembered, so the agent can sign in again
      // without asking twice, unless it asks for the consent screen.
      const nextSession = await adapter.createSession(user.id);
      const nextSignature = await makeSignature(nextSession.token, testSecret);
      const nextCookie = `invook.session_token=${encodeURIComponent(`${nextSession.token}.${nextSignature}`)}`;
      const nextPkce = createPkce();
      const reauthorize = await call(
        `/v1/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: "mail offline_access",
          code_challenge: nextPkce.challenge,
          code_challenge_method: "S256",
          resource,
        })}`,
        { headers: { cookie: nextCookie } },
      );
      const nextCode = new URL(reauthorize.headers.get("location") ?? "").searchParams.get("code");
      assert.ok(nextCode);
      const nextExchange = await call("/v1/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: nextCode,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: nextPkce.verifier,
          resource,
        }),
      });
      const live = (await nextExchange.json()) as TokenResponse;
      assert.ok(await grantFor(live.access_token));

      const connections = await listMcpConnections({ userId }, database);
      assert.deepEqual(
        connections.map((connection) => [connection.clientId, connection.name]),
        [[client.client_id, "Test Agent"]],
      );

      // Revoking disconnects the agent immediately, consent included.
      assert.equal(
        await revokeMcpConnection({ userId, clientId: client.client_id }, database),
        true,
      );
      assert.equal(await grantFor(live.access_token), null);
      assert.notEqual((await refresh(live.refresh_token ?? "")).status, 200);
      assert.deepEqual(await listMcpConnections({ userId }, database), []);
      assert.equal(
        await revokeMcpConnection({ userId, clientId: client.client_id }, database),
        false,
      );
    } finally {
      if (userId) await adapter.deleteUser(userId);
      for (const clientId of clientIds) {
        await database
          .delete(databaseSchema.oauthClients)
          .where(eq(databaseSchema.oauthClients.clientId, clientId));
      }
      await databaseClient.end();
    }
  },
);

test(
  "a person who denies consent sends the agent away without a code",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const databaseClient = postgres(testDatabaseUrl, { max: 2, prepare: false });
    const database = drizzle(databaseClient, { schema: databaseSchema });
    const auth = createInvookAuth(
      {
        appUrl: appOrigin,
        secret: testSecret,
        googleClientId: "database-test-client-id",
        googleClientSecret: "database-test-client-secret",
      },
      database,
    );
    const adapter = (await auth.$context).internalAdapter;
    const call = (path: string, init: RequestInit = {}) =>
      auth.handler(new Request(`${appOrigin}${path}`, init));
    let userId: string | null = null;
    let clientId: string | null = null;

    try {
      const user = await adapter.createUser({
        name: "MCP Consent Denial Test",
        email: `mcp-deny-${uuidv4()}@example.test`,
        image: null,
      });
      userId = user.id;
      const session = await adapter.createSession(user.id);
      const signature = await makeSignature(session.token, testSecret);
      const cookie = `invook.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
      const registration = await call("/v1/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Declined Agent",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
      });
      clientId = ((await registration.json()) as { client_id: string }).client_id;

      const pkce = createPkce();
      const authorize = await call(
        `/v1/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "mail",
          state: "declined",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          resource,
        })}`,
        { headers: { cookie } },
      );
      const consentLocation = new URL(authorize.headers.get("location") ?? "", appOrigin);
      const denial = await call("/v1/auth/oauth2/consent", {
        method: "POST",
        headers: { cookie, origin: appOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          accept: false,
          oauth_query: consentLocation.search.slice(1),
        }),
      });
      const callback = new URL(((await denial.json()) as { url: string }).url);

      assert.equal(callback.searchParams.get("error"), "access_denied");
      assert.equal(callback.searchParams.get("code"), null);
      assert.deepEqual(await listMcpConnections({ userId }, database), []);

      // Management endpoints Invook does not use are unreachable.
      const createClient = await call("/v1/auth/oauth2/create-client", {
        method: "POST",
        headers: { cookie, origin: appOrigin, "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      assert.equal(createClient.status, 404);
    } finally {
      if (userId) await adapter.deleteUser(userId);
      if (clientId) {
        await database
          .delete(databaseSchema.oauthClients)
          .where(eq(databaseSchema.oauthClients.clientId, clientId));
      }
      await databaseClient.end();
    }
  },
);

/** A Google ID token as Google's token endpoint returns it over TLS. */
function googleIdToken(claims: Record<string, unknown>): string {
  const encode = (value: object) => base64Url(Buffer.from(JSON.stringify(value)));
  return `${encode({ alg: "RS256", kid: "test" })}.${encode(claims)}.signature`;
}

test(
  "a signed-out person signs in with Google and the agent's authorization resumes",
  { skip: !testDatabaseUrl },
  async (context) => {
    if (!testDatabaseUrl) return;
    const databaseClient = postgres(testDatabaseUrl, { max: 2, prepare: false });
    const database = drizzle(databaseClient, { schema: databaseSchema });
    const auth = createInvookAuth(
      {
        appUrl: appOrigin,
        secret: testSecret,
        googleClientId: "database-test-client-id",
        googleClientSecret: "database-test-client-secret",
      },
      database,
    );
    const adapter = (await auth.$context).internalAdapter;
    const call = (path: string, init: RequestInit = {}) =>
      auth.handler(new Request(`${appOrigin}${path}`, init));
    const email = `mcp-google-${uuidv4()}@example.test`;
    let clientId: string | null = null;

    // Google's token endpoint is the only network call the callback makes.
    const originalFetch = globalThis.fetch;
    const tokenRequests: string[] = [];
    context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://oauth2.googleapis.com/token")) {
        return originalFetch(input, init);
      }
      tokenRequests.push(url);
      return Response.json({
        access_token: "google-access-token",
        expires_in: 3599,
        token_type: "Bearer",
        scope: "openid email profile",
        id_token: googleIdToken({
          iss: "https://accounts.google.com",
          aud: "database-test-client-id",
          sub: `google-${uuidv4()}`,
          email,
          email_verified: true,
          name: "Signed Out Person",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
        }),
      });
    });

    try {
      const registration = await call("/v1/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Signed Out Agent",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
          scope: "mail offline_access",
        }),
      });
      clientId = ((await registration.json()) as { client_id: string }).client_id;

      const pkce = createPkce();
      const authorize = await call(
        `/v1/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "mail offline_access",
          state: "signed-out-agent",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          resource,
        })}`,
      );
      const signInPage = new URL(authorize.headers.get("location") ?? "", appOrigin);
      assert.equal(signInPage.pathname, "/sign-in");

      // The sign-in page starts Google sign-in with the signed request.
      const signIn = await call("/v1/auth/sign-in/social", {
        method: "POST",
        headers: { origin: appOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/sign-in",
          oauth_query: signInPage.search.slice(1),
        }),
      });
      assert.equal(signIn.status, 200);
      const googleUrl = new URL(((await signIn.json()) as { url: string }).url);
      const stateCookie = signIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .find((cookie) => cookie?.startsWith("invook.state="));
      assert.ok(stateCookie);

      // Google returns the browser to Invook, which resumes the agent's request.
      const callback = await call(
        `/v1/auth/callback/google?${new URLSearchParams({
          code: "google-authorization-code",
          state: googleUrl.searchParams.get("state") ?? "",
        })}`,
        {
          headers: {
            cookie: stateCookie,
            accept: "text/html",
            "sec-fetch-mode": "navigate",
          },
        },
      );
      assert.equal(callback.status, 302);
      assert.equal(tokenRequests.length, 1);
      const consentPage = new URL(callback.headers.get("location") ?? "", appOrigin);
      assert.equal(consentPage.pathname, "/oauth/consent");
      assert.equal(consentPage.searchParams.get("client_id"), clientId);
      const sessionCookie = callback.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .find((cookie) => cookie?.startsWith("invook.session_token="));
      assert.ok(sessionCookie);

      const consent = await call("/v1/auth/oauth2/consent", {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          origin: appOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
      });
      const agentCallback = new URL(((await consent.json()) as { url: string }).url);
      assert.equal(agentCallback.searchParams.get("state"), "signed-out-agent");
      const code = agentCallback.searchParams.get("code");
      assert.ok(code);

      const exchange = await call("/v1/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: pkce.verifier,
          resource,
        }),
      });
      assert.equal(exchange.status, 200);
      const tokens = (await exchange.json()) as TokenResponse;
      const user = await adapter.findUserByEmail(email);
      assert.ok(user);
      assert.deepEqual(
        await getMcpAccessGrant({ tokenHash: hashOAuthToken(tokens.access_token) }, database),
        { userId: user.user.id, clientId, scopes: ["mail", "offline_access"] },
      );
    } finally {
      const user = await adapter.findUserByEmail(email);
      if (user) await adapter.deleteUser(user.user.id);
      if (clientId) {
        await database
          .delete(databaseSchema.oauthClients)
          .where(eq(databaseSchema.oauthClients.clientId, clientId));
      }
      await databaseClient.end();
    }
  },
);
