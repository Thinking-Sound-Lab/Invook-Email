import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "control lock waiters beyond the pool size do not starve the query pool",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    process.env.DATABASE_URL = testDatabaseUrl;
    const { getDatabase, withGmailAccountControlLock } = await import(
      "./client"
    );
    const state = globalThis as typeof globalThis & {
      invookDatabaseConnection?: { client: { end: () => Promise<void> } };
      invookControlLockConnection?: { client: { end: () => Promise<void> } };
    };
    try {
      const accountId = uuidv4();
      // More concurrent lock requests than either pool holds. Every locked
      // operation queries the shared pool, which deadlocks if lock waiters
      // reserve connections from that same pool.
      let activeHolders = 0;
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          withGmailAccountControlLock(accountId, async () => {
            activeHolders += 1;
            assert.equal(activeHolders, 1);
            await getDatabase().execute(sql`select 1`);
            activeHolders -= 1;
            return index;
          }),
        ),
      );
      assert.deepEqual(
        [...results].sort((left, right) => left - right),
        Array.from({ length: 12 }, (_, index) => index),
      );
    } finally {
      await state.invookDatabaseConnection?.client.end();
      await state.invookControlLockConnection?.client.end();
    }
  },
);
