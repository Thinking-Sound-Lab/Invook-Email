import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface LocalResetEnvironment {
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  s3Bucket: string | undefined;
  s3Endpoint: string | undefined;
}

type JsonRecord = Record<string, unknown>;

const EXPECTED_SERVICE_NAMES = [
  "api",
  "db",
  "migrate",
  "minio",
  "minio-init",
  "redis",
  "web",
  "worker",
];

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`${description} is missing or invalid.`);
  }
  return value;
}

function requireService(services: JsonRecord, serviceName: string): JsonRecord {
  return requireRecord(services[serviceName], `Compose service ${serviceName}`);
}

function requireEnvironment(service: JsonRecord, serviceName: string): JsonRecord {
  return requireRecord(
    service.environment,
    `Compose service ${serviceName} environment`,
  );
}

function assertEnvironmentValue(
  service: JsonRecord,
  serviceName: string,
  variableName: string,
  expectedValue: string,
): void {
  const environment = requireEnvironment(service, serviceName);
  if (environment[variableName] !== expectedValue) {
    throw new Error(
      `Compose service ${serviceName} must use the known local ${variableName} value.`,
    );
  }
}

function assertNamedVolume(
  service: JsonRecord,
  serviceName: string,
  expectedSource: string,
  expectedTarget: string,
): void {
  const volumes = service.volumes;
  if (!Array.isArray(volumes) || volumes.length !== 1) {
    throw new Error(
      `Compose service ${serviceName} must have exactly one known local volume.`,
    );
  }
  const volume = requireRecord(volumes[0], `Compose service ${serviceName} volume`);
  if (
    volume.type !== "volume" ||
    volume.source !== expectedSource ||
    volume.target !== expectedTarget
  ) {
    throw new Error(
      `Compose service ${serviceName} is not using its known local named volume.`,
    );
  }
}

interface ExpectedPort {
  hostIp?: string;
  published: string;
  target: number;
}

function assertPorts(
  service: JsonRecord,
  serviceName: string,
  expectedPorts: ExpectedPort[],
): void {
  const ports = service.ports;
  if (!Array.isArray(ports) || ports.length !== expectedPorts.length) {
    throw new Error(
      `Compose service ${serviceName} does not expose the known local ports.`,
    );
  }
  for (const expectedPort of expectedPorts) {
    const hasExpectedPort = ports.some((value: unknown) => {
      const port = requireRecord(value, `Compose service ${serviceName} port`);
      return (
        port.target === expectedPort.target &&
        port.published === expectedPort.published &&
        port.protocol === "tcp" &&
        port.mode === "ingress" &&
        port.host_ip === expectedPort.hostIp
      );
    });
    if (!hasExpectedPort) {
      throw new Error(
        `Compose service ${serviceName} does not expose the known local ports.`,
      );
    }
  }
}

function parseUrl(value: string | undefined, variableName: string): URL {
  if (!value) {
    throw new Error(`${variableName} must be configured in .env.local.`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`${variableName} in .env.local is not a valid URL.`);
  }
}

function assertLocalDatabaseUrl(value: string | undefined): void {
  const databaseUrl = parseUrl(value, "DATABASE_URL");
  const isLocalHost =
    databaseUrl.hostname === "127.0.0.1" ||
    databaseUrl.hostname === "localhost";
  if (
    databaseUrl.protocol !== "postgresql:" ||
    !isLocalHost ||
    databaseUrl.port !== "54322" ||
    databaseUrl.pathname !== "/invook" ||
    databaseUrl.username !== "invook" ||
    databaseUrl.password !== "invook" ||
    databaseUrl.search !== "" ||
    databaseUrl.hash !== ""
  ) {
    throw new Error(
      "DATABASE_URL must target the known Invook PostgreSQL service on localhost:54322.",
    );
  }
}

function assertLocalRedisUrl(value: string | undefined): void {
  const redisUrl = parseUrl(value, "REDIS_URL");
  const isLocalHost =
    redisUrl.hostname === "127.0.0.1" || redisUrl.hostname === "localhost";
  const isDatabaseZero =
    redisUrl.pathname === "" ||
    redisUrl.pathname === "/" ||
    redisUrl.pathname === "/0";
  if (
    redisUrl.protocol !== "redis:" ||
    !isLocalHost ||
    redisUrl.port !== "63790" ||
    !isDatabaseZero ||
    redisUrl.username !== "" ||
    redisUrl.password !== "" ||
    redisUrl.search !== "" ||
    redisUrl.hash !== ""
  ) {
    throw new Error(
      "REDIS_URL must target database 0 of the known Invook Redis service on localhost:63790.",
    );
  }
}

function assertLocalObjectStorage(environment: LocalResetEnvironment): void {
  if (
    environment.s3Endpoint !== undefined &&
    environment.s3Endpoint !== "" &&
    environment.s3Endpoint !== "http://localhost:9000" &&
    environment.s3Endpoint !== "http://127.0.0.1:9000"
  ) {
    throw new Error(
      "S3_ENDPOINT must target the known Invook MinIO service on localhost:9000.",
    );
  }
  if (
    environment.s3Bucket !== undefined &&
    environment.s3Bucket !== "" &&
    environment.s3Bucket !== "invook-mail"
  ) {
    throw new Error("S3_BUCKET must be the known local invook-mail bucket.");
  }
}

function assertTopLevelVolumes(composeConfig: JsonRecord): void {
  const volumes = requireRecord(composeConfig.volumes, "Compose volumes");
  const expectedVolumeNames: Record<string, string> = {
    "invook-minio": "invook_invook-minio",
    "invook-postgres": "invook_invook-postgres",
    "invook-redis": "invook_invook-redis",
  };
  if (
    Object.keys(volumes).sort().join(",") !==
    Object.keys(expectedVolumeNames).sort().join(",")
  ) {
    throw new Error("Compose must define only the known Invook local volumes.");
  }
  for (const [volumeName, expectedResolvedName] of Object.entries(
    expectedVolumeNames,
  )) {
    const volume = requireRecord(volumes[volumeName], `Compose volume ${volumeName}`);
    if (volume.name !== expectedResolvedName) {
      throw new Error(
        `Compose volume ${volumeName} does not resolve to the known local volume.`,
      );
    }
  }
}

export function validateLocalResetConfiguration(
  composeValue: unknown,
  environment: LocalResetEnvironment,
): void {
  assertLocalDatabaseUrl(environment.databaseUrl);
  assertLocalRedisUrl(environment.redisUrl);
  assertLocalObjectStorage(environment);

  const composeConfig = requireRecord(composeValue, "Compose configuration");
  if (composeConfig.name !== "invook") {
    throw new Error("Compose project name must be invook.");
  }
  const services = requireRecord(composeConfig.services, "Compose services");
  if (
    Object.keys(services).sort().join(",") !==
    [...EXPECTED_SERVICE_NAMES].sort().join(",")
  ) {
    throw new Error("Compose services do not match the known Invook local stack.");
  }

  const api = requireService(services, "api");
  const database = requireService(services, "db");
  const migrate = requireService(services, "migrate");
  const minio = requireService(services, "minio");
  const minioInit = requireService(services, "minio-init");
  const redis = requireService(services, "redis");
  const web = requireService(services, "web");
  const worker = requireService(services, "worker");

  assertEnvironmentValue(database, "db", "POSTGRES_USER", "invook");
  assertEnvironmentValue(database, "db", "POSTGRES_PASSWORD", "invook");
  assertEnvironmentValue(database, "db", "POSTGRES_DB", "invook");
  assertEnvironmentValue(
    api,
    "api",
    "DATABASE_URL",
    "postgresql://invook:invook@db:5432/invook",
  );
  assertEnvironmentValue(
    migrate,
    "migrate",
    "DATABASE_URL",
    "postgresql://invook:invook@db:5432/invook",
  );
  assertEnvironmentValue(
    worker,
    "worker",
    "DATABASE_URL",
    "postgresql://invook:invook@db:5432/invook",
  );
  assertEnvironmentValue(worker, "worker", "REDIS_URL", "redis://redis:6379");
  assertEnvironmentValue(worker, "worker", "S3_ENDPOINT", "http://minio:9000");
  assertEnvironmentValue(worker, "worker", "S3_BUCKET", "invook-mail");
  assertEnvironmentValue(minioInit, "minio-init", "S3_BUCKET", "invook-mail");

  assertNamedVolume(database, "db", "invook-postgres", "/var/lib/postgresql/data");
  assertNamedVolume(redis, "redis", "invook-redis", "/data");
  assertNamedVolume(minio, "minio", "invook-minio", "/data");

  assertPorts(database, "db", [{ published: "54322", target: 5432 }]);
  assertPorts(redis, "redis", [{ published: "63790", target: 6379 }]);
  assertPorts(minio, "minio", [
    { hostIp: "127.0.0.1", published: "9000", target: 9000 },
    { hostIp: "127.0.0.1", published: "9001", target: 9001 },
  ]);
  assertPorts(api, "api", [{ published: "4000", target: 4000 }]);
  assertPorts(web, "web", [{ published: "3000", target: 3000 }]);

  assertTopLevelVolumes(composeConfig);
}

function runCli(): void {
  try {
    const composeConfig: unknown = JSON.parse(readFileSync(0, "utf8"));
    validateLocalResetConfiguration(composeConfig, {
      databaseUrl: process.env.DATABASE_URL,
      redisUrl: process.env.REDIS_URL,
      s3Bucket: process.env.S3_BUCKET,
      s3Endpoint: process.env.S3_ENDPOINT,
    });
    console.info("Local reset safety checks passed.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown validation error.";
    console.error(`Refusing local reset: ${message}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  runCli();
}
