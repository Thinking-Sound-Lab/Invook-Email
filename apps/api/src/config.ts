const requiredApiVariables = [
  "APP_URL",
  "DATABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
] as const;

export function getMissingApiConfiguration(): string[] {
  return requiredApiVariables.filter((name) => !process.env[name]?.trim());
}

export function getPublicAppOrigin(): string {
  const configuredValue = process.env.APP_URL?.trim();
  if (!configuredValue) throw new Error("APP_URL is required by the API.");

  const url = new URL(configuredValue);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("APP_URL must use HTTP or HTTPS.");
  }

  return url.origin;
}

export function usesSecureCookies(): boolean {
  return getPublicAppOrigin().startsWith("https://");
}

export function getApiHost(): string {
  return "0.0.0.0";
}

export function getApiPort(): number {
  return 4000;
}
