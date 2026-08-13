import assert from "node:assert/strict";
import test from "node:test";

import { count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { v4 as uuidv4 } from "uuid";

import {
  approveMailboxActionProposal,
  createMailboxActionProposal,
  getMailboxActionProposalForUser,
  MailboxActionConflictError,
} from "./mailbox-actions";
import {
  connectedAccounts,
  gmailLabels,
  gmailReplicaStates,
  messages,
  profiles,
  queueOutbox,
  threads,
  workflowSteps,
} from "./schema";
import * as schema from "./schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "proposal ownership, frozen targets, payload substitution, and duplicate approval",
  { skip: !testDatabaseUrl },
  async () => {
    if (!testDatabaseUrl) return;
    const client = postgres(testDatabaseUrl, { max: 1, prepare: false });
    const database = drizzle(client, { schema });
    const ownerUserId = uuidv4();
    const otherUserId = uuidv4();
    const accountId = uuidv4();
    const threadId = uuidv4();
    const firstMessageId = uuidv4();
    const secondMessageId = uuidv4();
    try {
      await database.insert(profiles).values([
        { id: ownerUserId },
        { id: otherUserId },
      ]);
      await database.insert(connectedAccounts).values({
        id: accountId,
        userId: ownerUserId,
        providerAccountId: `provider-${accountId}`,
        email: "owner@example.com",
        memoryAcknowledgedAt: new Date(),
      });
      await database.insert(gmailReplicaStates).values({
        accountId,
        initialHistoryId: "100",
        historyCursor: "100",
        state: "ready",
      });
      await database.insert(threads).values({
        id: threadId,
        userId: ownerUserId,
        accountId,
        providerThreadId: `provider-thread-${threadId}`,
        subject: "Frozen targets",
      });
      await database.insert(messages).values([
        {
          id: firstMessageId,
          userId: ownerUserId,
          accountId,
          threadId,
          providerMessageId: `provider-message-${firstMessageId}`,
          direction: "incoming",
          sender: { raw: "Sender <sender@example.com>", email: "sender@example.com" },
          internalDate: new Date("2026-08-13T08:00:00.000Z"),
          sentAt: new Date("2026-08-13T08:00:00.000Z"),
        },
        {
          id: secondMessageId,
          userId: ownerUserId,
          accountId,
          threadId,
          providerMessageId: `provider-message-${secondMessageId}`,
          direction: "incoming",
          sender: { raw: "Other <other@example.com>", email: "other@example.com" },
          internalDate: new Date("2026-08-13T09:00:00.000Z"),
          sentAt: new Date("2026-08-13T09:00:00.000Z"),
        },
      ]);
      await database.insert(gmailLabels).values({
        userId: ownerUserId,
        accountId,
        providerLabelId: "INBOX",
        name: "Inbox",
        type: "system",
      });

      const proposal = await createMailboxActionProposal(
        {
          userId: ownerUserId,
          toolCallId: "tool-call-frozen",
          operation: "archive",
          messageIds: [firstMessageId],
        },
        database,
      );
      assert.ok(proposal);
      assert.deepEqual(
        proposal.targets.map((target) => target.messageId),
        [firstMessageId],
      );

      assert.equal(
        await getMailboxActionProposalForUser(
          { userId: otherUserId, proposalId: proposal.id },
          database,
        ),
        null,
      );
      const denied = await approveMailboxActionProposal(
        { userId: otherUserId, proposalId: proposal.id },
        database,
      );
      assert.equal(denied.outcome, "not_found");

      await assert.rejects(
        createMailboxActionProposal(
          {
            userId: ownerUserId,
            toolCallId: "tool-call-frozen",
            operation: "archive",
            messageIds: [secondMessageId],
          },
          database,
        ),
        MailboxActionConflictError,
      );

      const firstApproval = await approveMailboxActionProposal(
        { userId: ownerUserId, proposalId: proposal.id },
        database,
      );
      const duplicateApproval = await approveMailboxActionProposal(
        { userId: ownerUserId, proposalId: proposal.id },
        database,
      );
      assert.equal(firstApproval.outcome, "approved");
      assert.equal(duplicateApproval.outcome, "already_approved");

      const [workflowCount] = await database
        .select({ value: count(workflowSteps.id) })
        .from(workflowSteps)
        .where(eq(workflowSteps.idempotencyKey, `gmail-action:${proposal.id}`));
      const [outboxCount] = await database
        .select({ value: count(queueOutbox.id) })
        .from(queueOutbox)
        .where(eq(queueOutbox.workflowStepId, firstApproval.proposal?.workflowStepId ?? ""));
      assert.equal(workflowCount?.value, 1);
      assert.equal(outboxCount?.value, 1);
    } finally {
      await database
        .delete(profiles)
        .where(inArray(profiles.id, [ownerUserId, otherUserId]));
      await client.end();
    }
  },
);
