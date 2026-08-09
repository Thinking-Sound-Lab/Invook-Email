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

export async function listenForJobNotifications(onJobAvailable: () => void) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for worker notifications.");
  }

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  const listener = await client.listen("invook_jobs", onJobAvailable);

  return async () => {
    await listener.unlisten();
    await client.end();
  };
}
