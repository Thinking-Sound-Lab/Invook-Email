import axios from "axios";

export interface ObjectStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type ObjectStorageCredentialSource =
  | { type: "static"; credentials: ObjectStorageCredentials }
  | { type: "ecs"; relativeUri: string };

interface ExpiringCredentials {
  credentials: ObjectStorageCredentials;
  expiresAt: number;
}

function requireCredential(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Object storage credentials are missing ${name}.`);
  }
  return value.trim();
}

export function getObjectStorageCredentialSource(
  environment: NodeJS.ProcessEnv = process.env,
): ObjectStorageCredentialSource {
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId || secretAccessKey) {
    return {
      type: "static",
      credentials: {
        accessKeyId: requireCredential("S3_ACCESS_KEY_ID", accessKeyId),
        secretAccessKey: requireCredential("S3_SECRET_ACCESS_KEY", secretAccessKey),
        ...(environment.S3_SESSION_TOKEN?.trim()
          ? { sessionToken: environment.S3_SESSION_TOKEN.trim() }
          : {}),
      },
    };
  }

  const relativeUri = environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  // Fargate supplies a relative path, never a user-selected credentials host.
  if (!relativeUri || !/^\/v2\/credentials\/[a-zA-Z0-9-]+$/.test(relativeUri)) {
    throw new Error("Object storage requires S3 credentials or an ECS task IAM role.");
  }
  return { type: "ecs", relativeUri };
}

function parseEcsCredentials(value: unknown, now: number): ExpiringCredentials {
  if (typeof value !== "object" || value === null) {
    throw new Error("ECS returned invalid object storage credentials.");
  }
  const accessKeyId = requireCredential(
    "AccessKeyId", "AccessKeyId" in value ? value.AccessKeyId : undefined,
  );
  const secretAccessKey = requireCredential(
    "SecretAccessKey", "SecretAccessKey" in value ? value.SecretAccessKey : undefined,
  );
  const sessionToken = requireCredential("Token", "Token" in value ? value.Token : undefined);
  const expiration = requireCredential(
    "Expiration", "Expiration" in value ? value.Expiration : undefined,
  );
  const expiresAt = Date.parse(expiration);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("ECS returned expired object storage credentials.");
  }
  return { credentials: { accessKeyId, secretAccessKey, sessionToken }, expiresAt };
}

export function createObjectStorageCredentialProvider(
  source: ObjectStorageCredentialSource,
  dependencies: {
    now?: () => number;
    load?: (url: string) => Promise<unknown>;
  } = {},
): () => Promise<ObjectStorageCredentials> {
  if (source.type === "static") return async () => source.credentials;

  const now = dependencies.now ?? Date.now;
  const load = dependencies.load ?? (async (url: string): Promise<unknown> => {
    try {
      const response = await axios.get<unknown>(url, { proxy: false, maxRedirects: 0 });
      return response.data;
    } catch {
      // Axios errors retain response credentials; never propagate that error.
      throw new Error("Unable to retrieve ECS object storage credentials.");
    }
  });
  let cached: ExpiringCredentials | undefined;
  let pending: Promise<ExpiringCredentials> | undefined;

  return async () => {
    // Refresh on use, before expiration, rather than scheduling a process timer.
    if (cached && cached.expiresAt - now() > 60_000) return cached.credentials;
    pending ??= load(`http://169.254.170.2${source.relativeUri}`)
      .then((value) => parseEcsCredentials(value, now()));
    const current = pending;
    try {
      cached = await current;
      return cached.credentials;
    } finally {
      if (pending === current) pending = undefined;
    }
  };
}
