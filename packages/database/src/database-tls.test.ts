import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { test } from "node:test";

import { getDatabaseMigrationCredentials, getDatabaseTlsOptions } from "./database-tls";

test("Supabase connections verify the server against the vendor CA", () => {
  for (const host of ["db.protocol-test.supabase.co", "aws-0-ap-southeast-1.pooler.supabase.com"]) {
    const { ssl } = getDatabaseTlsOptions(`postgresql://postgres:protocol-test@${host}:5432/postgres`);
    assert.equal(ssl?.rejectUnauthorized, true);
    assert.ok(ssl);
    const certificate = new X509Certificate(ssl.ca);
    assert.equal(certificate.ca, true);
    assert.match(certificate.subject, /Supabase Root 2021 CA/);
  }
});

test("other PostgreSQL hosts preserve their URL-defined TLS configuration", () => {
  for (const host of ["localhost", "db", "postgres.example.com", "db.supabase.co.attacker.invalid", "pooler.supabase.com.attacker.invalid"]) {
    const url = `postgresql://postgres:protocol-test@${host}:5432/postgres?sslmode=verify-full`;
    assert.deepEqual(getDatabaseTlsOptions(url), {});
    assert.deepEqual(getDatabaseMigrationCredentials(url), { url });
  }
});

test("Supabase migrations retain verified TLS and decode credential components", () => {
  const credentials = getDatabaseMigrationCredentials("postgresql://postgres.project:protocol%3Atest%40secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full");
  assert.ok("ssl" in credentials);
  assert.equal(credentials.host, "aws-0-ap-southeast-1.pooler.supabase.com");
  assert.equal(credentials.port, 5432);
  assert.equal(credentials.user, "postgres.project");
  assert.equal(credentials.password, "protocol:test@secret");
  assert.equal(credentials.database, "postgres");
  assert.equal(credentials.ssl.rejectUnauthorized, true);
});

test("invalid database URLs fail without including credentials in errors", () => {
  for (const url of ["postgresql://private-input@", "https://postgres:private-input@db.project.supabase.co"]) {
    assert.throws(() => getDatabaseTlsOptions(url), error => error instanceof Error
      && !error.message.includes("private-input") && error.message.includes("DATABASE_URL"));
  }
});
