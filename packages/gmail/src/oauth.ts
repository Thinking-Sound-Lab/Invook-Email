import { createHash, randomBytes } from "node:crypto";

import axios from "axios";
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";

import { GmailApiError } from "./client";
import { GMAIL_SCOPES } from "./scopes";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

type GoogleOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

type GoogleJwkSet = {
  keys?: JWK[];
};

export type GoogleAuthorizationRequest = {
  url: string;
  codeVerifier: string;
};

export type GoogleAuthorizationResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scopes: string[];
  identity: {
    subject: string;
    email: string;
    displayName: string | null;
  };
};

export type VerifiedGoogleIdTokenClaims = {
  sub: string;
  email: string;
  email_verified: true;
  iss: string;
  aud: string | string[];
  exp: number;
};

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function grantedScopes(tokens: GoogleTokenResponse): string[] {
  return tokens.scope?.split(" ").filter(Boolean) ?? [...GMAIL_SCOPES];
}

/**
 * Verifies a Google-signed OIDC ID token, including its issuer, audience,
 * signature, and expiration. Callers remain responsible for authorizing the
 * returned identity, such as matching a Pub/Sub push service-account email.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  audience: string,
): Promise<VerifiedGoogleIdTokenClaims> {
  const protectedHeader = decodeProtectedHeader(idToken);
  if (!protectedHeader.kid || protectedHeader.alg !== "RS256") {
    throw new Error("Google returned an identity token with an unsupported key.");
  }

  let jwks: GoogleJwkSet;
  try {
    const response = await axios.get<GoogleJwkSet>(GOOGLE_JWKS_URL, {
      headers: { Accept: "application/json" },
    });
    jwks = response.data;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;
    throw GmailApiError.fromAxiosError(error, {
      operation: "Google identity key retrieval",
      method: "GET",
      path: GOOGLE_JWKS_URL,
    });
  }

  const jwk = jwks.keys?.find((candidate) => candidate.kid === protectedHeader.kid);
  if (!jwk) {
    throw new Error("Google did not publish the identity token signing key.");
  }

  const key = await importJWK(jwk, "RS256");
  const { payload } = await jwtVerify(idToken, key, {
    algorithms: ["RS256"],
    audience,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  if (
    !payload.sub ||
    typeof payload.email !== "string" ||
    payload.email_verified !== true ||
    typeof payload.iss !== "string" ||
    (typeof payload.aud !== "string" && !Array.isArray(payload.aud)) ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Google did not return a complete verified identity token.");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: true,
    iss: payload.iss,
    aud: payload.aud,
    exp: payload.exp,
  };
}

export async function createGoogleAuthorizationRequest(
  configuration: GoogleOAuthConfiguration & { state: string },
): Promise<GoogleAuthorizationRequest> {
  const codeVerifier = randomBytes(64).toString("base64url");
  const search = new URLSearchParams({
    access_type: "offline",
    client_id: configuration.clientId,
    code_challenge: base64UrlSha256(codeVerifier),
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    redirect_uri: configuration.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    state: configuration.state,
  });

  return {
    codeVerifier,
    url: `${GOOGLE_AUTHORIZATION_URL}?${search.toString()}`,
  };
}

export async function exchangeGoogleAuthorizationCode(
  configuration: GoogleOAuthConfiguration & {
    code: string;
    codeVerifier: string;
  },
): Promise<GoogleAuthorizationResult> {
  let tokens: GoogleTokenResponse;
  try {
    const response = await axios.post<GoogleTokenResponse>(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        code: configuration.code,
        code_verifier: configuration.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: configuration.redirectUri,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    tokens = response.data;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;
    throw GmailApiError.fromAxiosError(error, {
      operation: "Google authorization code exchange",
      method: "POST",
      path: GOOGLE_TOKEN_URL,
    });
  }

  if (!tokens.access_token || !tokens.id_token || !tokens.expires_in) {
    throw new Error("Google did not return the required identity and access tokens.");
  }

  const identity = await verifyGoogleIdToken(tokens.id_token, configuration.clientId);
  const identityPayload = decodeJwt(tokens.id_token);

  const scopes = grantedScopes(tokens);
  if (!scopes.includes("https://www.googleapis.com/auth/gmail.modify")) {
    throw new Error("The required Gmail permission was not granted.");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scopes,
    identity: {
      subject: identity.sub,
      email: identity.email,
      displayName:
        typeof identityPayload.name === "string" ? identityPayload.name : null,
    },
  };
}
