import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export type GoogleCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
};

const ENVELOPE_VERSION = "v1";

function parseEncryptionKey(value: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a 32-byte value encoded as base64 or 64 hexadecimal characters.",
    );
  }

  return key;
}

export function encryptGoogleCredential(
  credential: GoogleCredential,
  encryptionKey: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseEncryptionKey(encryptionKey), iv);
  const plaintext = Buffer.from(JSON.stringify(credential), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    authenticationTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptGoogleCredential(
  envelope: string,
  encryptionKey: string,
): GoogleCredential {
  const [version, encodedIv, encodedTag, encodedCiphertext] = envelope.split(".");

  if (
    version !== ENVELOPE_VERSION ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error("The stored Google credential has an unsupported format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    parseEncryptionKey(encryptionKey),
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<GoogleCredential>;

  if (
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    !Array.isArray(parsed.scopes)
  ) {
    throw new Error("The stored Google credential is incomplete.");
  }

  return parsed as GoogleCredential;
}
