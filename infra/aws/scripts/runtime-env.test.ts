import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIGURATION_KEYS, CONFIGURATION_PARAMETER_NAMES, RUNTIME_KEYS, SECRET_KEYS, type RuntimeEnvironment,
} from "../lib/runtime-environment";
import { parseProductionRuntime, validateProductionRuntime, writeRuntimeEnvironment } from "./runtime-env";

function createRuntime(): RuntimeEnvironment {
  const runtime = {
    ...Object.fromEntries(RUNTIME_KEYS.map((key) => [key, "test-only-value"])),
    APP_URL: "https://mail.example.com",
    DATABASE_URL: "postgres://test-user:test-password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    BETTER_AUTH_SECRET: "test-only-secret-".repeat(3),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  validateProductionRuntime(runtime);
  return runtime;
}

function serializeSecrets(runtime: RuntimeEnvironment): string {
  return JSON.stringify(Object.fromEntries(SECRET_KEYS.map((name) => [name, runtime[name]])));
}

function serializeParameters(runtime: RuntimeEnvironment): string {
  return JSON.stringify(CONFIGURATION_KEYS.map((name) => ({
    ParameterKey: CONFIGURATION_PARAMETER_NAMES[name], ParameterValue: runtime[name],
  })));
}

test("release validation requires credentials, session pooling and verified database TLS", () => {
  const runtime = createRuntime();
  assert.throws(() => validateProductionRuntime({ ...runtime, TEMPORAL_API_KEY: "" }), /TEMPORAL_API_KEY/);
  assert.throws(() => validateProductionRuntime({
    ...runtime, DATABASE_URL: runtime.DATABASE_URL.replace(":5432/", ":6543/"),
  }), /session pooler/);
  assert.throws(() => validateProductionRuntime({
    ...runtime, DATABASE_URL: runtime.DATABASE_URL.replace("verify-full", "require"),
  }), /verify-full/);
  assert.throws(() => validateProductionRuntime({ ...runtime, APP_URL: "http://localhost:3000" }), /HTTPS origin/);
});

test("invalid connection URLs do not disclose credential text in errors", () => {
  const runtime = createRuntime();
  const credentialText = "sensitive-test-only-password";
  assert.throws(() => validateProductionRuntime({ ...runtime, DATABASE_URL: credentialText }), (error: unknown) =>
    error instanceof Error && error.message === "DATABASE_URL must be a valid URL." && !error.message.includes(credentialText));
});

test("malformed runtime secrets do not expose JSON input in errors", () => {
  assert.throws(() => parseProductionRuntime("sensitive-test-only-password", "[]"), (error: unknown) =>
    error instanceof Error && error.message === "Production runtime secret must be valid JSON.");
  const runtime = createRuntime();
  assert.throws(() => parseProductionRuntime(serializeSecrets(runtime), "sensitive-test-only-value"), (error: unknown) =>
    error instanceof Error && error.message === "CloudFormation parameters must be valid JSON.");
});

test("release validates the deployed secret together with CloudFormation settings", () => {
  const runtime = createRuntime();
  assert.deepEqual(parseProductionRuntime(serializeSecrets(runtime), serializeParameters(runtime)), runtime);
  assert.throws(() => parseProductionRuntime(JSON.stringify(runtime), serializeParameters(runtime)), /only the documented secret/);
  assert.throws(() => parseProductionRuntime(serializeSecrets(runtime), "[]"), /CloudFormation setting/);
  assert.throws(() => parseProductionRuntime(serializeSecrets(runtime), '{"AppUrl":"https://mail.example.com"}'), /string keys and values/);
  assert.throws(() => parseProductionRuntime(serializeSecrets({ ...runtime, TEMPORAL_API_KEY: "" }), serializeParameters(runtime)), /TEMPORAL_API_KEY/);
  assert.throws(() => parseProductionRuntime(serializeSecrets(runtime), serializeParameters({ ...runtime, TEMPORAL_NAMESPACE: "" })), /TEMPORAL_NAMESPACE/);
});

test("configuration splits values without changing generated keys and limits file permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "invook-runtime-test-"));
  try {
    const source = join(directory, "production.env");
    const target = join(directory, "runtime.json");
    const settings = join(directory, "settings.txt");
    writeFileSync(source, readFileSync(new URL("../production.env.example", import.meta.url), "utf8"));
    writeRuntimeEnvironment(source, target, settings);
    const first: unknown = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(target, "utf8"))).sort(), [...SECRET_KEYS].sort());
    assert.equal(readFileSync(settings, "utf8"), CONFIGURATION_KEYS.map((name) => CONFIGURATION_PARAMETER_NAMES[name] + "=\n").join(""));
    writeRuntimeEnvironment(source, target, settings);
    const second: unknown = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(second, first);
    assert.equal(statSync(source).mode & 0o777, 0o600);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(settings).mode & 0o777, 0o600);
    const parameters = serializeParameters({ ...createRuntime(), APP_URL: "" });
    assert.throws(() => parseProductionRuntime(readFileSync(target, "utf8"), parameters), /Fill production variables/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configuration rejects multiline settings before creating deployment arguments", () => {
  const directory = mkdtempSync(join(tmpdir(), "invook-runtime-test-"));
  try {
    const source = join(directory, "production.env");
    writeFileSync(source, 'APP_URL="https://mail.example.com\nApiCount=4"');
    assert.throws(() => writeRuntimeEnvironment(source, join(directory, "secrets.json"), join(directory, "settings.txt")), /APP_URL must be a single-line/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
