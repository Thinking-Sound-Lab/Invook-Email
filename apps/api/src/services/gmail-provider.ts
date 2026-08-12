import {
  decryptGoogleCredential,
  encryptGoogleCredential,
  getGmailProviderWriteContext,
  updateStoredCredential,
  type GoogleCredential,
} from "@invook/database";
import { refreshGoogleAccessToken } from "@invook/gmail";

export class GmailProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailProviderConfigurationError";
  }
}

export type GmailProviderAccess = {
  accessToken: string;
  accountId: string;
  email: string;
};

export type GmailProviderAccessResult =
  | { status: "not_found" | "replica_not_ready"; access: null }
  | { status: "ready"; access: GmailProviderAccess };

async function refreshCredentialIfRequired(
  accountId: string,
  credential: GoogleCredential,
): Promise<GoogleCredential> {
  const expiration = Date.parse(credential.expiresAt);
  const expiresSoon =
    !Number.isFinite(expiration) || expiration <= Date.now() + 60_000;
  if (!expiresSoon) return credential;

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!clientId || !clientSecret || !encryptionKey) {
    throw new GmailProviderConfigurationError(
      "Google provider-write credentials are not configured.",
    );
  }

  const refreshed = await refreshGoogleAccessToken({
    refreshToken: credential.refreshToken,
    clientId,
    clientSecret,
  });
  const nextCredential: GoogleCredential = {
    ...credential,
    accessToken: refreshed.accessToken,
    expiresAt: new Date(Date.now() + refreshed.expiresIn * 1_000).toISOString(),
    scopes: refreshed.scope?.split(" ").filter(Boolean) ?? credential.scopes,
  };
  await updateStoredCredential(
    accountId,
    encryptGoogleCredential(nextCredential, encryptionKey),
  );
  return nextCredential;
}

export async function getGmailProviderAccess(
  userId: string,
): Promise<GmailProviderAccessResult> {
  const context = await getGmailProviderWriteContext(userId);
  if (!context) return { status: "not_found", access: null };
  if (context.replicaState !== "ready") {
    return { status: "replica_not_ready", access: null };
  }

  const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!encryptionKey) {
    throw new GmailProviderConfigurationError(
      "Google provider-write credentials are not configured.",
    );
  }
  const storedCredential = decryptGoogleCredential(
    context.tokenCiphertext,
    encryptionKey,
  );
  const credential = await refreshCredentialIfRequired(
    context.accountId,
    storedCredential,
  );
  return {
    status: "ready",
    access: {
      accessToken: credential.accessToken,
      accountId: context.accountId,
      email: context.email,
    },
  };
}
