import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIGURATION_DEFAULTS, CONFIGURATION_KEYS, CONFIGURATION_PARAMETER_NAMES, RUNTIME_KEYS, SECRET_KEYS, type RuntimeEnvironment,
} from "../lib/runtime-environment";
import { parseProductionRuntime, validateProductionRuntime, writeRuntimeEnvironment } from "./runtime-env";

function createRuntime(): RuntimeEnvironment {
  const runtime = {
    ...Object.fromEntries(RUNTIME_KEYS.map((key) => [key, "test-only-value"])),
    DATABASE_POOL_SIZE: "3",
    DATABASE_CONTROL_POOL_SIZE: "2",
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

test("release rejects invalid query or advisory-lock pool capacities", () => {
  const runtime = createRuntime();
  for (const name of ["DATABASE_POOL_SIZE", "DATABASE_CONTROL_POOL_SIZE"] as const) {
    for (const value of ["0", "-1", "1.5", "9007199254740992", "private-input"]) {
      assert.throws(() => validateProductionRuntime({ ...runtime, [name]: value }), (error: unknown) =>
        error instanceof Error && error.message === name + " must be a positive integer.");
    }
  }
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
    assert.equal(readFileSync(settings, "utf8"), CONFIGURATION_KEYS.map((name) => CONFIGURATION_PARAMETER_NAMES[name] + "=" + (CONFIGURATION_DEFAULTS[name] ?? "") + "\n").join(""));
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

test("older private env files receive persisted pool defaults without changing credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "invook-runtime-pool-test-"));
  try {
    const source = join(directory, "production.env");
    const secretTarget = join(directory, "runtime.json");
    const settingsTarget = join(directory, "settings.txt");
    const runtime = createRuntime();
    writeFileSync(source, RUNTIME_KEYS.filter((name) => name !== "DATABASE_POOL_SIZE" && name !== "DATABASE_CONTROL_POOL_SIZE")
      .map((name) => name + "=" + runtime[name]).join("\n") + "\n");
    writeRuntimeEnvironment(source, secretTarget, settingsTarget);
    assert.equal(readFileSync(secretTarget, "utf8"), serializeSecrets(runtime));
    assert.match(readFileSync(source, "utf8"), /^DATABASE_POOL_SIZE=3$/m);
    assert.match(readFileSync(source, "utf8"), /^DATABASE_CONTROL_POOL_SIZE=2$/m);
    writeRuntimeEnvironment(source, secretTarget, settingsTarget);
    assert.equal(readFileSync(secretTarget, "utf8"), serializeSecrets(runtime));
    assert.equal(readFileSync(source, "utf8").match(/^DATABASE_POOL_SIZE=/gm)?.length, 1);
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
