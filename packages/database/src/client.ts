import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

type DatabaseConnection = {
  url: string;
  database: Database;
  client: ReturnType<typeof postgres>;
};

const databaseState = globalThis as typeof globalThis & {
  invookDatabaseConnection?: DatabaseConnection;
};

function openDatabase(databaseUrl: string): DatabaseConnection {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for application data access.");
  }

  const client = postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });

  return {
    url: databaseUrl,
    database: drizzle(client, { schema }),
    client,
  };
}

export function createDatabase(databaseUrl: string): Database {
  return openDatabase(databaseUrl).database;
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

  const connection = openDatabase(databaseUrl);
  databaseState.invookDatabaseConnection = connection;
  return connection.database;
}

export async function withGmailAccountControlLock<T>(
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockName = `gmail-control:${accountId}`;
  getDatabase();
  const client = databaseState.invookDatabaseConnection?.client;
  if (!client) throw new Error("The database connection is unavailable.");
  const connection = await client.reserve();
  let locked = false;
  try {
    await connection`select pg_advisory_lock(hashtextextended(${lockName}, 0))`;
    locked = true;
    return await operation();
  } finally {
    try {
      if (locked) {
        await connection`select pg_advisory_unlock(hashtextextended(${lockName}, 0))`;
      }
    } finally {
      connection.release();
    }
  }
}

async function listenForDatabaseNotifications(
  channel:
    | "invook_queue_outbox"
    | "invook_account_sync"
    | "invook_mailbox_changes",
  onNotification: (payload: string) => void,
  onSubscribed?: () => void,
  onSubscriptionLost?: () => void,
) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database notifications.");
  }

  let isStopping = false;
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onclose: () => {
      if (!isStopping) onSubscriptionLost?.();
    },
  });
  const listener = await client.listen(channel, onNotification, onSubscribed);

  return async () => {
    isStopping = true;
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

export function listenForMailboxChangeNotifications(
  input: {
    onNotification: (payload: string) => void;
    onSubscribed: () => void;
    onSubscriptionLost: () => void;
  },
) {
  return listenForDatabaseNotifications(
    "invook_mailbox_changes",
    input.onNotification,
    input.onSubscribed,
    input.onSubscriptionLost,
  );
}
