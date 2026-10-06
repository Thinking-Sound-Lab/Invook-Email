export function getApiUrl(
  path: string,
  apiOrigin = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000",
): URL {
  const base = new URL(apiOrigin);
  if (!["http:", "https:"].includes(base.protocol) || base.search || base.hash) {
    throw new Error("API_INTERNAL_URL must be an HTTP URL without a query or fragment.");
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("An API path must start with one slash.");
  }
  return new URL(`${base.toString().replace(/\/$/, "")}${path}`);
}
