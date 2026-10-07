import { readFileSync } from "node:fs";

interface DatabaseTlsOptions {
  ssl?: {
    ca: string;
    rejectUnauthorized: true;
  };
}

type DatabaseMigrationCredentials = { url: string } | {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: NonNullable<DatabaseTlsOptions["ssl"]>;
};

export function getDatabaseTlsOptions(databaseUrl: string): DatabaseTlsOptions {
  let connectionUrl: URL;
  try {
    connectionUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(connectionUrl.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  const isSupabaseHost = connectionUrl.hostname.endsWith(".supabase.co")
    || connectionUrl.hostname.endsWith(".pooler.supabase.com");
  if (!isSupabaseHost) return {};

  return {
    ssl: {
      ca: readFileSync(new URL("../certificates/supabase-root-2021.crt", import.meta.url), "utf8"),
      rejectUnauthorized: true,
    },
  };
}

export function getDatabaseMigrationCredentials(databaseUrl: string): DatabaseMigrationCredentials {
  const { ssl } = getDatabaseTlsOptions(databaseUrl);
  if (!ssl) return { url: databaseUrl };
  const connectionUrl = new URL(databaseUrl);
  // Drizzle Kit ignores a separate SSL object when credentials contain `url`.
  return {
    host: connectionUrl.hostname,
    port: Number(connectionUrl.port || 5432),
    user: decodeURIComponent(connectionUrl.username),
    password: decodeURIComponent(connectionUrl.password),
    database: decodeURIComponent(connectionUrl.pathname.slice(1) || "postgres"),
    ssl,
  };
}
