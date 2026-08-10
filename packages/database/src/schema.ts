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
import type { LabelAnalysisState, SystemLabelKey } from "@invook/contracts";

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
      .default({ recent: "pending", memory: "pending", history: "pending" }),
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

export const mailLabels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description").notNull(),
    systemKey: text("system_key").$type<SystemLabelKey>(),
    definitionVersion: integer("definition_version").notNull().default(1),
    analysisState: text("analysis_state")
      .$type<LabelAnalysisState>()
      .notNull()
      .default("pending"),
    lastAnalyzedAt: timestampWithTimezone("last_analyzed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("labels_account_name_idx").on(table.accountId, table.normalizedName),
    uniqueIndex("labels_account_system_key_idx").on(table.accountId, table.systemKey),
    index("labels_account_created_idx").on(table.accountId, table.createdAt),
    check("labels_name_check", sql`char_length(btrim(${table.name})) > 0`),
    check(
      "labels_normalized_name_check",
      sql`char_length(btrim(${table.normalizedName})) > 0`,
    ),
    check(
      "labels_description_check",
      sql`char_length(btrim(${table.description})) > 0`,
    ),
    check(
      "labels_system_key_check",
      sql`${table.systemKey} is null or ${table.systemKey} in ('important', 'travel', 'pitch', 'newsletter')`,
    ),
    check("labels_definition_version_check", sql`${table.definitionVersion} > 0`),
    check(
      "labels_analysis_state_check",
      sql`${table.analysisState} in ('pending', 'running', 'complete', 'failed')`,
    ),
  ],
);

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
    labelId: uuid("label_id")
      .notNull()
      .references(() => mailLabels.id, { onDelete: "cascade" }),
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
    uniqueIndex("thread_labels_thread_label_idx").on(table.threadId, table.labelId),
    index("thread_labels_account_label_state_idx").on(
      table.accountId,
      table.labelId,
      table.state,
    ),
    check("thread_labels_source_check", sql`${table.source} in ('ai', 'user')`),
    check("thread_labels_state_check", sql`${table.state} in ('applied', 'dismissed')`),
    check(
      "thread_labels_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} between 0 and 100`,
    ),
  ],
);

export const threadLabelAnalyses = pgTable(
  "thread_label_analyses",
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
    labelId: uuid("label_id")
      .notNull()
      .references(() => mailLabels.id, { onDelete: "cascade" }),
    definitionVersion: integer("definition_version").notNull(),
    modelId: text("model_id"),
    analyzedAt: timestampWithTimezone("analyzed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("thread_label_analyses_thread_label_idx").on(
      table.threadId,
      table.labelId,
    ),
    index("thread_label_analyses_label_version_idx").on(
      table.labelId,
      table.definitionVersion,
    ),
    check(
      "thread_label_analyses_definition_version_check",
      sql`${table.definitionVersion} > 0`,
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
    index("messages_memory_eligible_idx")
      .on(table.userId, table.sentAt)
      .where(
        sql`${table.direction} = 'outgoing' and ${table.isMemoryEligible} and not ${table.excludedFromMemory}`,
      ),
    check("messages_direction_check", sql`${table.direction} in ('incoming', 'outgoing')`),
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

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => connectedAccounts.id, {
      onDelete: "cascade",
    }),
    jobType: text("job_type").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "retry" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    result: jsonb("result").$type<JsonObject>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestampWithTimezone("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("jobs_idempotency_key_idx").on(table.idempotencyKey),
    index("jobs_ready_idx")
      .on(table.status, table.createdAt)
      .where(sql`${table.status} in ('queued', 'retry')`),
    check(
      "jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'retry', 'complete', 'failed')`,
    ),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
    check("jobs_max_attempts_check", sql`${table.maxAttempts} > 0`),
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
