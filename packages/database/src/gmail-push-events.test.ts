import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import { ingestGmailPushEvent } from "./replica";
import { gmailPushEvents } from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Gmail pushes without a connected account are acknowledged without storage",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const providerEventId = `unmatched-${uuidv4()}`;
    try {
      const result = await ingestGmailPushEvent(
        {
          providerEventId,
          emailAddress: `${uuidv4()}@example.com`,
          notificationHistoryId: "100",
          subscription: "projects/invook/subscriptions/gmail-mailbox-changes",
          publishedAt: new Date(),
          payload: { message: { messageId: providerEventId } },
        },
        database,
      );

      assert.deepEqual(result, { status: "ignored", accountId: null });
      assert.deepEqual(
        await database
          .select({ id: gmailPushEvents.id })
          .from(gmailPushEvents)
          .where(eq(gmailPushEvents.providerEventId, providerEventId)),
        [],
      );
    } finally {
      await database
        .delete(gmailPushEvents)
        .where(eq(gmailPushEvents.providerEventId, providerEventId));
      await client.end();
    }
  },
);
