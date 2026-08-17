import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateLocalResetConfiguration } from "./reset-local-config.ts";

const localEnvironment = {
  databaseUrl: "postgresql://invook:invook@127.0.0.1:54322/invook",
  s3Bucket: "invook-mail",
  s3Endpoint: "http://localhost:9000",
};

function createComposeConfig() {
  const databaseUrl = "postgresql://invook:invook@db:5432/invook";
  const port = (target: number, published: string, hostIp?: string) => ({
    mode: "ingress",
    ...(hostIp ? { host_ip: hostIp } : {}),
    protocol: "tcp",
    published,
    target,
  });
  return {
    name: "invook",
    services: {
      api: {
        environment: { DATABASE_URL: databaseUrl },
        ports: [port(4000, "4000")],
      },
      db: {
        environment: {
          POSTGRES_DB: "invook",
          POSTGRES_PASSWORD: "invook",
          POSTGRES_USER: "invook",
        },
        ports: [port(5432, "54322")],
        volumes: [
          {
            source: "invook-postgres",
            target: "/var/lib/postgresql/data",
            type: "volume",
          },
        ],
      },
      migrate: { environment: { DATABASE_URL: databaseUrl } },
      minio: {
        ports: [
          port(9000, "9000", "127.0.0.1"),
          port(9001, "9001", "127.0.0.1"),
        ],
        volumes: [
          { source: "invook-minio", target: "/data", type: "volume" },
        ],
      },
      "minio-init": { environment: { S3_BUCKET: "invook-mail" } },
      web: { ports: [port(3000, "3000")] },
      worker: {
        environment: {
          DATABASE_URL: databaseUrl,
          S3_BUCKET: "invook-mail",
          S3_ENDPOINT: "http://minio:9000",
        },
      },
    },
    volumes: {
      "invook-minio": { name: "invook_invook-minio" },
      "invook-postgres": { name: "invook_invook-postgres" },
    },
  };
}

describe("validateLocalResetConfiguration", () => {
  it("accepts the known local Docker configuration", () => {
    assert.doesNotThrow(() =>
      validateLocalResetConfiguration(createComposeConfig(), localEnvironment),
    );
  });

  it("rejects a remote PostgreSQL target", () => {
    assert.throws(
      () =>
        validateLocalResetConfiguration(createComposeConfig(), {
          ...localEnvironment,
          databaseUrl: "postgresql://invook:invook@db.example.com:5432/invook",
        }),
      /known Invook PostgreSQL service/,
    );
  });

  it("rejects another Compose project", () => {
    const composeConfig = createComposeConfig();
    composeConfig.name = "invook-production";
    assert.throws(
      () => validateLocalResetConfiguration(composeConfig, localEnvironment),
      /project name must be invook/,
    );
  });

  it("rejects an unknown service", () => {
    const composeConfig = createComposeConfig();
    Object.assign(composeConfig.services, { analytics: {} });
    assert.throws(
      () => validateLocalResetConfiguration(composeConfig, localEnvironment),
      /services do not match/,
    );
  });

  it("rejects a different PostgreSQL volume", () => {
    const composeConfig = createComposeConfig();
    composeConfig.services.db.volumes[0].source = "shared-postgres";
    assert.throws(
      () => validateLocalResetConfiguration(composeConfig, localEnvironment),
      /known local named volume/,
    );
  });

  it("rejects another object-storage bucket", () => {
    assert.throws(
      () =>
        validateLocalResetConfiguration(createComposeConfig(), {
          ...localEnvironment,
          s3Bucket: "shared-mail",
        }),
      /known local invook-mail bucket/,
    );
  });
});
