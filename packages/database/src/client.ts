import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

type DatabaseConnection = {
  url: string;
  database: Database;
};

const databaseState = globalThis as typeof globalThis & {
  invookDatabaseConnection?: DatabaseConnection;
};

export function createDatabase(databaseUrl: string): Database {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for application data access.");
  }

  const client = postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });

  return drizzle(client, { schema });
}

export function getDatabase(): Database {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const existing = databaseState.invookDatabaseConnection;

  if (existing) {
    if (existing.url !== databaseUrl) {
      throw new Error("DATABASE_URL changed after the database connection was created.");
    }
    return existing.database;
  }

  const database = createDatabase(databaseUrl);
  databaseState.invookDatabaseConnection = { url: databaseUrl, database };
  return database;
}

async function listenForDatabaseNotifications(
  channel:
    | "invook_jobs"
    | "invook_job_status"
    | "invook_queue_outbox"
    | "invook_account_sync",
  onNotification: (payload: string) => void,
) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database notifications.");
  }

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const listener = await client.listen(channel, onNotification);

  return async () => {
    await listener.unlisten();
    await client.end();
  };
}

export function listenForOutboxNotifications(onEntryAvailable: () => void) {
  return listenForDatabaseNotifications("invook_queue_outbox", onEntryAvailable);
}

export function listenForAccountSyncNotifications(
  onAccountSyncChanged: (payload: string) => void,
) {
  return listenForDatabaseNotifications("invook_account_sync", onAccountSyncChanged);
}

export function listenForJobNotifications(onJobAvailable: () => void) {
  return listenForDatabaseNotifications("invook_jobs", onJobAvailable);
}

export function listenForJobStatusNotifications(
  onStatusChanged: (jobId: string) => void,
) {
  return listenForDatabaseNotifications("invook_job_status", onStatusChanged);
}
