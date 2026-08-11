import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { AccountSyncState } from "./types";

type JsonObject = Record<string, unknown>;
type JsonValue = JsonObject | unknown[];

const timestampWithTimezone = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const searchVector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map(Number);
  },
});

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name"),
  memoryAcknowledgedAt: timestampWithTimezone("memory_acknowledged_at"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"gmail">().notNull().default("gmail"),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email").notNull(),
    status: text("status")
      .$type<"connected" | "reconnect_required" | "disconnected">()
      .notNull()
      .default("connected"),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    memoryAcknowledgedAt: timestampWithTimezone("memory_acknowledged_at").notNull(),
    historyCursor: text("history_cursor"),
    syncState: jsonb("sync_state")
      .$type<AccountSyncState>()
      .notNull()
      .default({ mailSync: "pending", indexing: "pending", memory: "pending" }),
    lastSyncedAt: timestampWithTimezone("last_synced_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("connected_accounts_provider_identity_idx").on(
      table.provider,
      table.providerAccountId,
    ),
    index("connected_accounts_user_created_idx").on(table.userId, table.createdAt),
    check("connected_accounts_provider_check", sql`${table.provider} = 'gmail'`),
    check(
      "connected_accounts_status_check",
      sql`${table.status} in ('connected', 'reconnect_required', 'disconnected')`,
    ),
  ],
);

export const accountSecrets = pgTable("account_secrets", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  keyVersion: smallint("key_version").notNull().default(1),
  refreshedAt: timestampWithTimezone("refreshed_at"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    participants: jsonb("participants").$type<string[]>().notNull().default([]),
    labelIds: text("label_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    classificationVersion: integer("classification_version").notNull().default(0),
    classifiedAt: timestampWithTimezone("classified_at"),
    latestMessageAt: timestampWithTimezone("latest_message_at"),
    messageCount: integer("message_count").notNull().default(0),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("threads_account_provider_thread_idx").on(
      table.accountId,
      table.providerThreadId,
    ),
    index("threads_user_latest_idx").on(table.userId, table.latestMessageAt),
    check("threads_message_count_check", sql`${table.messageCount} >= 0`),
  ],
);

export const threadLabels = pgTable(
  "thread_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    labelKey: text("label_key")
      .$type<"important" | "travel" | "pitch" | "newsletter">()
      .notNull(),
    source: text("source").$type<"ai" | "user">().notNull(),
    state: text("state").$type<"applied" | "dismissed">().notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    modelId: text("model_id"),
    analysisVersion: integer("analysis_version").notNull().default(1),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("thread_labels_thread_key_idx").on(table.threadId, table.labelKey),
    index("thread_labels_account_key_state_idx").on(
      table.accountId,
      table.labelKey,
      table.state,
    ),
    check(
      "thread_labels_key_check",
      sql`${table.labelKey} in ('important', 'travel', 'pitch', 'newsletter')`,
    ),
    check("thread_labels_source_check", sql`${table.source} in ('ai', 'user')`),
    check("thread_labels_state_check", sql`${table.state} in ('applied', 'dismissed')`),
    check(
      "thread_labels_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} between 0 and 100`,
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    direction: text("direction").$type<"incoming" | "outgoing">().notNull(),
    sender: jsonb("sender")
      .$type<{ raw: string; email: string }>()
      .notNull(),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    labelIds: text("label_ids").array().notNull().default(sql`ARRAY[]::text[]`),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    sentAt: timestampWithTimezone("sent_at").notNull(),
    isMemoryEligible: boolean("is_memory_eligible").notNull().default(false),
    excludedFromMemory: boolean("excluded_from_memory").notNull().default(false),
    searchDocument: searchVector("search_document").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(${sql.raw("subject")}, '') || ' ' || coalesce(${sql.raw("body_text")}, ''))`,
    ),
    metadataSearchDocument: searchVector(
      "metadata_search_document",
    ).generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(${sql.raw("sender")}->>'raw', '') || ' ' || coalesce(${sql.raw("sender")}->>'email', '') || ' ' || coalesce(${sql.raw("recipients")}::text, ''))`,
    ),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("messages_thread_provider_message_idx").on(
      table.threadId,
      table.providerMessageId,
    ),
    index("messages_thread_sent_idx").on(table.threadId, table.sentAt),
    index("messages_search_idx").using("gin", table.searchDocument),
    index("messages_metadata_search_idx").using(
      "gin",
      table.metadataSearchDocument,
    ),
    index("messages_memory_eligible_idx")
      .on(table.userId, table.sentAt)
      .where(
        sql`${table.direction} = 'outgoing' and ${table.isMemoryEligible} and not ${table.excludedFromMemory}`,
      ),
    check("messages_direction_check", sql`${table.direction} in ('incoming', 'outgoing')`),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id"),
    filename: text("filename").notNull(),
    filenameSearchDocument: searchVector(
      "filename_search_document",
    ).generatedAlwaysAs(
      sql`to_tsvector('simple', regexp_replace(${sql.raw("filename")}, '[_\\.-]+', ' ', 'g'))`,
    ),
    mimeType: text("mime_type"),
    size: integer("size"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("message_attachments_message_idx").on(table.messageId),
    index("message_attachments_account_filename_idx").on(
      table.accountId,
      table.filename,
    ),
    index("message_attachments_filename_search_idx").using(
      "gin",
      table.filenameSearchDocument,
    ),
    check(
      "message_attachments_size_check",
      sql`${table.size} is null or ${table.size} >= 0`,
    ),
  ],
);

export const messageEmbeddings = pgTable(
  "message_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    dimensions: integer("dimensions").notNull(),
    indexVersion: integer("index_version").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status")
      .$type<"pending" | "submitted" | "complete" | "failed">()
      .notNull()
      .default("pending"),
    embedding: embeddingVector("embedding"),
    providerBatchId: text("provider_batch_id"),
    lastError: text("last_error"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("message_embeddings_message_model_version_idx").on(
      table.messageId,
      table.modelId,
      table.indexVersion,
    ),
    index("message_embeddings_account_status_idx").on(
      table.accountId,
      table.modelId,
      table.indexVersion,
      table.status,
    ),
    check("message_embeddings_dimensions_check", sql`${table.dimensions} > 0`),
    check(
      "message_embeddings_status_check",
      sql`${table.status} in ('pending', 'submitted', 'complete', 'failed')`,
    ),
  ],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    memoryType: text("memory_type")
      .$type<"preference" | "contact" | "scheduling">()
      .notNull(),
    contactEmail: text("contact_email"),
    statement: text("statement").notNull(),
    source: text("source")
      .$type<"user" | "inferred" | "feedback">()
      .notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    evidenceMessageIds: uuid("evidence_message_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    evidenceDraftIds: uuid("evidence_draft_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    modelId: text("model_id"),
    schemaVersion: integer("schema_version").notNull().default(1),
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("memory_entries_account_fingerprint_idx").on(
      table.accountId,
      table.fingerprint,
    ),
    index("memory_entries_account_type_contact_idx").on(
      table.accountId,
      table.memoryType,
      table.contactEmail,
    ),
    check(
      "memory_entries_type_check",
      sql`${table.memoryType} in ('preference', 'contact', 'scheduling')`,
    ),
    check(
      "memory_entries_source_check",
      sql`${table.source} in ('user', 'inferred', 'feedback')`,
    ),
    check(
      "memory_entries_contact_check",
      sql`(${table.memoryType} = 'contact' and ${table.contactEmail} is not null) or (${table.memoryType} <> 'contact' and ${table.contactEmail} is null)`,
    ),
    check(
      "memory_entries_statement_check",
      sql`char_length(${table.statement}) between 3 and 500`,
    ),
    check(
      "memory_entries_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} between 0 and 100`,
    ),
  ],
);

export const memoryDeletions = pgTable(
  "memory_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    memoryType: text("memory_type")
      .$type<"preference" | "contact" | "scheduling">()
      .notNull(),
    contactEmail: text("contact_email"),
    fingerprint: text("fingerprint").notNull(),
    deletedAt: timestampWithTimezone("deleted_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_deletions_account_fingerprint_idx").on(
      table.accountId,
      table.fingerprint,
    ),
    index("memory_deletions_user_deleted_idx").on(table.userId, table.deletedAt),
    check(
      "memory_deletions_type_check",
      sql`${table.memoryType} in ('preference', 'contact', 'scheduling')`,
    ),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerDraftId: text("provider_draft_id"),
    status: text("status")
      .$type<"editing" | "sent" | "discarded" | "failed">()
      .notNull()
      .default("editing"),
    generatedText: text("generated_text"),
    currentText: text("current_text").notNull().default(""),
    finalSentText: text("final_sent_text"),
    usedMemoryIds: uuid("used_memory_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    generationMetadata: jsonb("generation_metadata")
      .$type<JsonObject>()
      .notNull()
      .default({}),
    editSignals: jsonb("edit_signals").$type<JsonValue[]>().notNull().default([]),
    feedbackVersion: integer("feedback_version").notNull().default(0),
    lastFeedbackAt: timestampWithTimezone("last_feedback_at"),
    generatedAt: timestampWithTimezone("generated_at"),
    sentAt: timestampWithTimezone("sent_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("drafts_user_updated_idx").on(table.userId, table.updatedAt),
    check(
      "drafts_status_check",
      sql`${table.status} in ('editing', 'sent', 'discarded', 'failed')`,
    ),
  ],
);

export const mailSyncRuns = pgTable(
  "mail_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    startingHistoryCursor: text("starting_history_cursor").notNull(),
    finalHistoryCursor: text("final_history_cursor"),
    discoveryComplete: boolean("discovery_complete").notNull().default(false),
    pageCount: integer("page_count").notNull().default(0),
    discoveredMessageCount: integer("discovered_message_count").notNull().default(0),
    processedMessageCount: integer("processed_message_count").notNull().default(0),
    failedMessageCount: integer("failed_message_count").notNull().default(0),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("mail_sync_runs_idempotency_key_idx").on(table.idempotencyKey),
    index("mail_sync_runs_account_created_idx").on(table.accountId, table.createdAt),
    check(
      "mail_sync_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check("mail_sync_runs_page_count_check", sql`${table.pageCount} >= 0`),
    check(
      "mail_sync_runs_message_counts_check",
      sql`${table.discoveredMessageCount} >= 0 and ${table.processedMessageCount} >= 0 and ${table.failedMessageCount} >= 0`,
    ),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => mailSyncRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, {
      onDelete: "cascade",
    }),
    stepType: text("step_type").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    input: jsonb("input").$type<JsonObject>().notNull().default({}),
    result: jsonb("result").$type<JsonObject>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("workflow_steps_idempotency_key_idx").on(table.idempotencyKey),
    index("workflow_steps_run_created_idx").on(table.runId, table.createdAt),
    index("workflow_steps_account_type_created_idx").on(
      table.accountId,
      table.stepType,
      table.createdAt,
    ),
    check(
      "workflow_steps_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check("workflow_steps_attempts_check", sql`${table.attempts} >= 0`),
    check("workflow_steps_max_attempts_check", sql`${table.maxAttempts} > 0`),
  ],
);

export const queueOutbox = pgTable(
  "queue_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowStepId: uuid("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id, { onDelete: "cascade" }),
    queueName: text("queue_name")
      .$type<
        | "gmail-pages"
        | "gmail-messages"
        | "mail-classification"
        | "mail-indexing-batch"
        | "mail-indexing-live"
        | "mail-memory-submit"
        | "mail-memory-events"
        | "mail-memory-feedback"
      >()
      .notNull(),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    lastError: text("last_error"),
    publishedAt: timestampWithTimezone("published_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("queue_outbox_workflow_step_idx").on(table.workflowStepId),
    index("queue_outbox_unpublished_idx")
      .on(table.createdAt)
      .where(sql`${table.publishedAt} is null`),
    check("queue_outbox_publish_attempts_check", sql`${table.publishAttempts} >= 0`),
    check(
      "queue_outbox_queue_name_check",
      sql`${table.queueName} in ('gmail-pages', 'gmail-messages', 'mail-classification', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback')`,
    ),
  ],
);

export const gmailSyncPages = pgTable(
  "gmail_sync_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => mailSyncRuns.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    pageToken: text("page_token"),
    nextPageToken: text("next_page_token"),
    discoveredMessageCount: integer("discovered_message_count").notNull().default(0),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    completedAt: timestampWithTimezone("completed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gmail_sync_pages_run_number_idx").on(table.runId, table.pageNumber),
    check("gmail_sync_pages_number_check", sql`${table.pageNumber} > 0`),
    check(
      "gmail_sync_pages_message_count_check",
      sql`${table.discoveredMessageCount} >= 0`,
    ),
  ],
);

export const gmailSyncItems = pgTable(
  "gmail_sync_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => mailSyncRuns.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_sync_items_run_message_idx").on(
      table.runId,
      table.providerMessageId,
    ),
    index("gmail_sync_items_run_status_idx").on(table.runId, table.status),
    check(
      "gmail_sync_items_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check("gmail_sync_items_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [index("audit_user_created_idx").on(table.userId, table.createdAt)],
);
