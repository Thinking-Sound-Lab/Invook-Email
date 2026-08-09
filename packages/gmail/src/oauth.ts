import {
  CodeChallengeMethod,
  OAuth2Client,
  type Credentials,
} from "google-auth-library";

import { GMAIL_SCOPES } from "./scopes";

type GoogleOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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

function createOAuthClient(configuration: GoogleOAuthConfiguration) {
  return new OAuth2Client({
    clientId: configuration.clientId,
    clientSecret: configuration.clientSecret,
    redirectUri: configuration.redirectUri,
  });
}

function getGrantedScopes(tokens: Credentials): string[] {
  return tokens.scope?.split(" ").filter(Boolean) ?? [...GMAIL_SCOPES];
}

export async function createGoogleAuthorizationRequest(
  configuration: GoogleOAuthConfiguration & { state: string },
): Promise<GoogleAuthorizationRequest> {
  const client = createOAuthClient(configuration);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  if (!codeChallenge) {
    throw new Error("Google OAuth did not create a PKCE challenge.");
  }

  return {
    codeVerifier,
    url: client.generateAuthUrl({
      access_type: "offline",
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      include_granted_scopes: true,
      prompt: "consent select_account",
      scope: [...GMAIL_SCOPES],
      state: configuration.state,
    }),
  };
}

export async function exchangeGoogleAuthorizationCode(
  configuration: GoogleOAuthConfiguration & {
    code: string;
    codeVerifier: string;
  },
): Promise<GoogleAuthorizationResult> {
  const client = createOAuthClient(configuration);
  const { tokens } = await client.getToken({
    code: configuration.code,
    codeVerifier: configuration.codeVerifier,
  });

  if (!tokens.access_token || !tokens.id_token) {
    throw new Error("Google did not return the required identity and access tokens.");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: configuration.clientId,
  });
  const payload = ticket.getPayload();

  if (
    !payload?.sub ||
    !payload.email ||
    payload.email_verified !== true
  ) {
    throw new Error("Google did not return a verified identity.");
  }

  const scopes = getGrantedScopes(tokens);
  if (!scopes.includes("https://www.googleapis.com/auth/gmail.modify")) {
    throw new Error("The required Gmail permission was not granted.");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 50 * 60 * 1000).toISOString(),
    scopes,
    identity: {
      subject: payload.sub,
      email: payload.email,
      displayName: payload.name ?? null,
    },
  };
}
