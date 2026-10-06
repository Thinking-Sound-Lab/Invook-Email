import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { RUNTIME_KEYS, type RuntimeEnvironment } from "../lib/runtime-environment";

function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && RUNTIME_KEYS.every((key) => key in value && typeof Reflect.get(value, key) === "string");
}

function parseRuntimeUrl(value: string, name: string): URL {
  try { return new URL(value); }
  catch { throw new Error(name + " must be a valid URL."); }
}

export function validateProductionRuntime(value: unknown): asserts value is RuntimeEnvironment {
  if (!isRuntimeEnvironment(value)) throw new Error("Runtime configuration must contain the documented string variables.");
  const missing = RUNTIME_KEYS.filter((name) => !value[name].trim());
  if (missing.length) throw new Error("Fill production variables: " + missing.join(", ") + ".");
  const appUrl = parseRuntimeUrl(value.APP_URL, "APP_URL");
  if (appUrl.protocol !== "https:" || appUrl.username || appUrl.password || appUrl.search
      || appUrl.hash || appUrl.pathname !== "/") {
    throw new Error("APP_URL must be an HTTPS origin.");
  }
  const databaseUrl = parseRuntimeUrl(value.DATABASE_URL, "DATABASE_URL");
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (["localhost", "127.0.0.1", "[::1]", "db"].includes(databaseUrl.hostname)) {
    throw new Error("Production DATABASE_URL cannot point to a local database.");
  }
  if (databaseUrl.hostname.endsWith(".pooler.supabase.com") && databaseUrl.port === "6543") {
    throw new Error("Use the Supabase session pooler on port 5432, not the transaction pooler.");
  }
  if (databaseUrl.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Production DATABASE_URL must verify the TLS certificate with sslmode=verify-full.");
  }
  if (value.BETTER_AUTH_SECRET.length < 32) throw new Error("BETTER_AUTH_SECRET must have at least 32 characters.");
  if (Buffer.from(value.TOKEN_ENCRYPTION_KEY, "base64").length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must encode 32 random bytes as base64.");
  }
}

export function parseProductionRuntime(value: string): RuntimeEnvironment {
  let runtime: unknown;
  try { runtime = JSON.parse(value); }
  catch { throw new Error("Production runtime secret must be valid JSON."); }
  validateProductionRuntime(runtime);
  return runtime;
}

export function writeRuntimeEnvironment(source: string, target: string): void {
  const content = readFileSync(source, "utf8");
  const environment = parseEnv(content);
  const runtime = Object.fromEntries(RUNTIME_KEYS.map((name) => [name, environment[name]?.trim() ?? ""]));
  let updatedContent = content;
  for (const name of ["BETTER_AUTH_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
    if (runtime[name]) continue;
    runtime[name] = randomBytes(32).toString("base64");
    const line = name + "=" + runtime[name];
    const pattern = new RegExp("^" + name + "=.*$", "m");
    updatedContent = pattern.test(updatedContent) ? updatedContent.replace(pattern, line) : updatedContent + "\n" + line + "\n";
  }
  // Persist generated keys; changing the encryption key loses access to stored mailbox grants.
  chmodSync(source, 0o600);
  writeFileSync(source, updatedContent);
  writeFileSync(target, JSON.stringify(runtime), { mode: 0o600 });
  chmodSync(target, 0o600);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, source, target] = process.argv.slice(2);
  if (action === "write") {
    if (!source || !target) throw new Error("Provide the production env file and output file.");
    writeRuntimeEnvironment(source, target);
  } else if (action === "check") {
    parseProductionRuntime(readFileSync(0, "utf8"));
    console.log("Production runtime variables are configured.");
  } else {
    throw new Error("Use write or check.");
  }
}
