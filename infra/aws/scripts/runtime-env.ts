import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import {
  CONFIGURATION_DEFAULTS, CONFIGURATION_KEYS, CONFIGURATION_PARAMETER_NAMES, RUNTIME_KEYS, SECRET_KEYS,
  type RuntimeEnvironment, type RuntimeSecrets,
} from "../lib/runtime-environment";

interface StackParameter {
  ParameterKey: string;
  ParameterValue: string;
}

function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && RUNTIME_KEYS.every((key) => key in value && typeof Reflect.get(value, key) === "string");
}

function isRuntimeSecrets(value: unknown): value is RuntimeSecrets {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === SECRET_KEYS.length
    && SECRET_KEYS.every((key) => key in value && typeof Reflect.get(value, key) === "string");
}

function isStackParameter(value: unknown): value is StackParameter {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "ParameterKey" in value && typeof value.ParameterKey === "string"
    && "ParameterValue" in value && typeof value.ParameterValue === "string";
}

function parseJson(value: string, description: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error(description + " must be valid JSON."); }
}

function parseRuntimeUrl(value: string, name: string): URL {
  try { return new URL(value); }
  catch { throw new Error(name + " must be a valid URL."); }
}

export function validateProductionRuntime(value: unknown): asserts value is RuntimeEnvironment {
  if (!isRuntimeEnvironment(value)) throw new Error("Runtime configuration must contain the documented string variables.");
  const missing = RUNTIME_KEYS.filter((name) => !value[name].trim());
  if (missing.length) throw new Error("Fill production variables: " + missing.join(", ") + ".");
  for (const name of CONFIGURATION_KEYS) {
    if (/[\r\n]/.test(value[name])) throw new Error(name + " must be a single-line setting.");
  }
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
  for (const name of ["DATABASE_POOL_SIZE", "DATABASE_CONTROL_POOL_SIZE"] as const) {
    if (!/^[1-9][0-9]*$/.test(value[name]) || !Number.isSafeInteger(Number(value[name]))) {
      throw new Error(name + " must be a positive integer.");
    }
  }
}

export function parseProductionRuntime(secretValue: string, parameterValue: string): RuntimeEnvironment {
  const secrets = parseJson(secretValue, "Production runtime secret");
  if (!isRuntimeSecrets(secrets)) throw new Error("Runtime secret must contain only the documented secret variables.");
  const parameters = parseJson(parameterValue, "CloudFormation parameters");
  if (!Array.isArray(parameters) || !parameters.every(isStackParameter)) {
    throw new Error("CloudFormation parameters must contain string keys and values.");
  }
  const configuration = CONFIGURATION_KEYS.map((name) => {
    const matches = parameters.filter((parameter) => parameter.ParameterKey === CONFIGURATION_PARAMETER_NAMES[name]);
    if (matches.length !== 1) throw new Error("Missing or duplicated CloudFormation setting: " + name);
    return [name, matches[0].ParameterValue];
  });
  const runtime = { ...Object.fromEntries(configuration), ...secrets };
  validateProductionRuntime(runtime);
  return runtime;
}

export function writeRuntimeEnvironment(source: string, secretTarget: string, configurationTarget: string): void {
  const content = readFileSync(source, "utf8");
  const environment = parseEnv(content);
  let updatedContent = content;
  for (const name of CONFIGURATION_KEYS) {
    const defaultValue = CONFIGURATION_DEFAULTS[name];
    if (environment[name] === undefined && defaultValue !== undefined) {
      environment[name] = defaultValue;
      updatedContent += "\n" + name + "=" + defaultValue + "\n";
    }
  }
  const runtime = Object.fromEntries(RUNTIME_KEYS.map((name) => [name, environment[name]?.trim() ?? ""]));
  for (const name of CONFIGURATION_KEYS) {
    if (/[\r\n]/.test(runtime[name])) throw new Error(name + " must be a single-line setting.");
  }
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
  const secrets = Object.fromEntries(SECRET_KEYS.map((name) => [name, runtime[name]]));
  const configuration = CONFIGURATION_KEYS.map((name) => CONFIGURATION_PARAMETER_NAMES[name] + "=" + runtime[name]).join("\n");
  for (const [target, value] of [[secretTarget, JSON.stringify(secrets)], [configurationTarget, configuration + "\n"]]) {
    writeFileSync(target, value, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, source, target, configurationTarget] = process.argv.slice(2);
  if (action === "write") {
    if (!source || !target || !configurationTarget) throw new Error("Provide the production env file, secret output and settings output.");
    writeRuntimeEnvironment(source, target, configurationTarget);
  } else if (action === "check") {
    if (!source || !target) throw new Error("Provide the runtime secret and CloudFormation parameter files.");
    parseProductionRuntime(readFileSync(source, "utf8"), readFileSync(target, "utf8"));
    console.log("Production runtime variables are configured.");
  } else {
    throw new Error("Use write or check.");
  }
}
