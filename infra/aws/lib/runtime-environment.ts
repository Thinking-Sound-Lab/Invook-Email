export const API_CONFIGURATION_KEYS = [
  "APP_URL", "BETTER_AUTH_GOOGLE_CLIENT_ID", "GMAIL_GOOGLE_CLIENT_ID", "GMAIL_PUBSUB_TOPIC",
  "GOOGLE_PUBSUB_PUSH_AUDIENCE", "GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PUBSUB_SUBSCRIPTION",
] as const;

export const WORKER_CONFIGURATION_KEYS = [
  "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "GMAIL_GOOGLE_CLIENT_ID", "GMAIL_PUBSUB_TOPIC",
] as const;

export const API_SECRET_KEYS = [
  "DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_GOOGLE_CLIENT_SECRET",
  "GMAIL_GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY", "OPENAI_WEBHOOK_SECRET",
] as const;

export const WORKER_SECRET_KEYS = [
  "DATABASE_URL", "TEMPORAL_API_KEY", "GMAIL_GOOGLE_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY", "OPENAI_API_KEY", "OPENAI_WEBHOOK_SECRET",
] as const;

export type RuntimeConfigurationKey =
  | (typeof API_CONFIGURATION_KEYS)[number]
  | (typeof WORKER_CONFIGURATION_KEYS)[number];
export type RuntimeSecretKey =
  | (typeof API_SECRET_KEYS)[number]
  | (typeof WORKER_SECRET_KEYS)[number];
export type RuntimeEnvironmentKey = RuntimeConfigurationKey | RuntimeSecretKey;

export const CONFIGURATION_KEYS: readonly RuntimeConfigurationKey[] = [
  ...new Set<RuntimeConfigurationKey>([...API_CONFIGURATION_KEYS, ...WORKER_CONFIGURATION_KEYS]),
];

export const SECRET_KEYS: readonly RuntimeSecretKey[] = [
  ...new Set<RuntimeSecretKey>([...API_SECRET_KEYS, ...WORKER_SECRET_KEYS]),
];

export const CONFIGURATION_PARAMETER_NAMES = {
  APP_URL: "AppUrl",
  BETTER_AUTH_GOOGLE_CLIENT_ID: "BetterAuthGoogleClientId",
  GMAIL_GOOGLE_CLIENT_ID: "GmailGoogleClientId",
  GMAIL_PUBSUB_TOPIC: "GmailPubsubTopic",
  GOOGLE_PUBSUB_PUSH_AUDIENCE: "GooglePubsubPushAudience",
  GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: "GooglePubsubPushServiceAccountEmail",
  GOOGLE_PUBSUB_SUBSCRIPTION: "GooglePubsubSubscription",
  TEMPORAL_ADDRESS: "TemporalAddress",
  TEMPORAL_NAMESPACE: "TemporalNamespace",
} as const satisfies Record<RuntimeConfigurationKey, string>;

export const RUNTIME_KEYS: readonly RuntimeEnvironmentKey[] = [
  ...CONFIGURATION_KEYS, ...SECRET_KEYS,
];

export type RuntimeEnvironment = Record<RuntimeEnvironmentKey, string>;
export type RuntimeSecrets = Record<RuntimeSecretKey, string>;
