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
  vector,
} from "drizzle-orm/pg-core";
import type { LabelAnalysisState, SystemLabelKey } from "@invook/contracts";

import { MAIL_EMBEDDING_DIMENSIONS } from "@invook/contracts";

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

export const gmailReplicaStates = pgTable("gmail_replica_states", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  initialHistoryId: text("initial_history_id").notNull(),
  historyCursor: text("history_cursor"),
  state: text("state")
    .$type<
      | "pending"
      | "snapshotting"
      | "replaying"
      | "auditing"
      | "ready"
      | "repairing"
      | "failed"
      | "deleting"
    >()
    .notNull()
    .default("pending"),
  readyAt: timestampWithTimezone("ready_at"),
  lastHistoryAt: timestampWithTimezone("last_history_at"),
  lastAuditAt: timestampWithTimezone("last_audit_at"),
  lastError: text("last_error"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  index("gmail_replica_states_state_idx").on(table.state, table.updatedAt),
  check(
    "gmail_replica_states_state_check",
    sql`${table.state} in ('pending', 'snapshotting', 'replaying', 'auditing', 'ready', 'repairing', 'failed', 'deleting')`,
  ),
]);

export const gmailWatchStates = pgTable("gmail_watch_states", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => connectedAccounts.id, { onDelete: "cascade" }),
  topicName: text("topic_name").notNull(),
  historyId: text("history_id").notNull(),
  expirationAt: timestampWithTimezone("expiration_at").notNull(),
  status: text("status")
    .$type<"active" | "stopped" | "failed">()
    .notNull()
    .default("active"),
  lastRenewedAt: timestampWithTimezone("last_renewed_at").notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  updatedAt: timestampWithTimezone("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  index("gmail_watch_states_expiration_idx").on(table.status, table.expirationAt),
  check(
    "gmail_watch_states_status_check",
    sql`${table.status} in ('active', 'stopped', 'failed')`,
  ),
]);

export const gmailLabels = pgTable(
  "gmail_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    providerLabelId: text("provider_label_id").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<"system" | "user">().notNull(),
    messageListVisibility: text("message_list_visibility"),
    labelListVisibility: text("label_list_visibility"),
    color: jsonb("color").$type<{ textColor?: string; backgroundColor?: string }>(),
    providerMetadata: jsonb("provider_metadata").$type<JsonObject>().notNull().default({}),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_labels_account_provider_idx").on(
      table.accountId,
      table.providerLabelId,
    ),
    index("gmail_labels_account_name_idx").on(table.accountId, table.name),
    check("gmail_labels_type_check", sql`${table.type} in ('system', 'user')`),
  ],
);

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
    latestMessageAt: timestampWithTimezone("latest_message_at"),
    messageCount: integer("message_count").notNull().default(0),
    contentVersion: integer("content_version").notNull().default(1),
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
    check("threads_content_version_check", sql`${table.contentVersion} > 0`),
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
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    direction: text("direction").$type<"incoming" | "outgoing">().notNull(),
    sender: jsonb("sender")
      .$type<{ raw: string; email: string }>()
      .notNull(),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    providerHistoryId: text("provider_history_id"),
    internalDate: timestampWithTimezone("internal_date").notNull(),
    sizeEstimate: integer("size_estimate"),
    headerLines: jsonb("header_lines")
      .$type<Array<{ key: string; line: string }>>()
      .notNull()
      .default([]),
    subject: text("subject").notNull().default(""),
    snippet: text("snippet").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    rawObjectKey: text("raw_object_key"),
    rawChecksumSha256: text("raw_checksum_sha256"),
    rawContentLength: integer("raw_content_length"),
    rawEtag: text("raw_etag"),
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
    index("messages_account_provider_idx").on(table.accountId, table.providerMessageId),
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
    check(
      "messages_size_estimate_check",
      sql`${table.sizeEstimate} is null or ${table.sizeEstimate} >= 0`,
    ),
    check(
      "messages_raw_content_length_check",
      sql`${table.rawContentLength} is null or ${table.rawContentLength} >= 0`,
    ),
  ],
);

export const gmailMessageLabels = pgTable(
  "gmail_message_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    gmailLabelId: uuid("gmail_label_id")
      .notNull()
      .references(() => gmailLabels.id, { onDelete: "cascade" }),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gmail_message_labels_message_label_idx").on(
      table.messageId,
      table.gmailLabelId,
    ),
    index("gmail_message_labels_account_label_idx").on(
      table.accountId,
      table.gmailLabelId,
    ),
  ],
);

export const gmailMessageTombstones = pgTable(
  "gmail_message_tombstones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    providerThreadId: text("provider_thread_id"),
    providerHistoryId: text("provider_history_id"),
    objectKeys: jsonb("object_keys").$type<string[]>().notNull().default([]),
    deletedAt: timestampWithTimezone("deleted_at").notNull().defaultNow(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_message_tombstones_account_message_idx").on(
      table.accountId,
      table.providerMessageId,
    ),
    index("gmail_message_tombstones_account_deleted_idx").on(
      table.accountId,
      table.deletedAt,
    ),
  ],
);

export const memoryPendingEvidence = pgTable(
  "memory_pending_evidence",
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
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    scope: text("scope").$type<"global" | "contact">().notNull(),
    contactEmail: text("contact_email").notNull().default(""),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("memory_pending_evidence_message_scope_idx").on(
      table.messageId,
      table.scope,
      table.contactEmail,
    ),
    index("memory_pending_evidence_account_scope_idx").on(
      table.accountId,
      table.schemaVersion,
      table.scope,
      table.contactEmail,
      table.createdAt,
    ),
    check(
      "memory_pending_evidence_scope_check",
      sql`${table.scope} in ('global', 'contact')`,
    ),
    check(
      "memory_pending_evidence_contact_check",
      sql`(${table.scope} = 'global' and ${table.contactEmail} = '') or (${table.scope} = 'contact' and char_length(btrim(${table.contactEmail})) > 0)`,
    ),
    check(
      "memory_pending_evidence_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
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
    mimePartPath: text("mime_part_path"),
    filename: text("filename").notNull(),
    filenameSearchDocument: searchVector(
      "filename_search_document",
    ).generatedAlwaysAs(
      sql`to_tsvector('simple', regexp_replace(${sql.raw("filename")}, '[_\\.-]+', ' ', 'g'))`,
    ),
    mimeType: text("mime_type"),
    contentId: text("content_id"),
    contentDisposition: text("content_disposition"),
    size: integer("size"),
    objectKey: text("object_key"),
    checksumSha256: text("checksum_sha256"),
    contentLength: integer("content_length"),
    etag: text("etag"),
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
    check(
      "message_attachments_content_length_check",
      sql`${table.contentLength} is null or ${table.contentLength} >= 0`,
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
    embedding: vector("embedding", { dimensions: MAIL_EMBEDDING_DIMENSIONS }),
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
    index("message_embeddings_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(sql`${table.status} = 'complete'`),
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

export const gmailDrafts = pgTable(
  "gmail_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    providerDraftId: text("provider_draft_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    providerHistoryId: text("provider_history_id"),
    providerMetadata: jsonb("provider_metadata").$type<JsonObject>().notNull().default({}),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_drafts_account_provider_idx").on(
      table.accountId,
      table.providerDraftId,
    ),
    index("gmail_drafts_account_thread_idx").on(
      table.accountId,
      table.providerThreadId,
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

export const embeddingBatchSubmissions = pgTable(
  "embedding_batch_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowStepId: uuid("workflow_step_id")
      .notNull()
      .references(() => workflowSteps.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"openai">().notNull().default("openai"),
    providerBatchId: text("provider_batch_id"),
    inputFileId: text("input_file_id"),
    modelId: text("model_id").notNull(),
    dimensions: integer("dimensions").notNull(),
    indexVersion: integer("index_version").notNull(),
    batchAttempt: integer("batch_attempt").notNull().default(1),
    hasMore: boolean("has_more").notNull(),
    requestCount: integer("request_count").notNull(),
    manifest: jsonb("manifest")
      .$type<Array<{ key: string; messageId: string; contentHash: string }>>()
      .notNull(),
    status: text("status")
      .$type<"preparing" | "submitted" | "complete" | "failed">()
      .notNull()
      .default("preparing"),
    providerState: text("provider_state"),
    lastError: text("last_error"),
    submittedAt: timestampWithTimezone("submitted_at"),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("embedding_batch_submissions_workflow_step_idx").on(
      table.workflowStepId,
    ),
    uniqueIndex("embedding_batch_submissions_provider_batch_idx")
      .on(table.provider, table.providerBatchId)
      .where(sql`${table.providerBatchId} is not null`),
    uniqueIndex("embedding_batch_submissions_account_active_idx")
      .on(table.accountId)
      .where(sql`${table.status} in ('preparing', 'submitted')`),
    index("embedding_batch_submissions_account_status_idx").on(
      table.accountId,
      table.status,
      table.createdAt,
    ),
    check("embedding_batch_submissions_provider_check", sql`${table.provider} = 'openai'`),
    check(
      "embedding_batch_submissions_status_check",
      sql`${table.status} in ('preparing', 'submitted', 'complete', 'failed')`,
    ),
    check(
      "embedding_batch_submissions_dimensions_check",
      sql`${table.dimensions} = ${sql.raw(String(MAIL_EMBEDDING_DIMENSIONS))}`,
    ),
    check(
      "embedding_batch_submissions_request_count_check",
      sql`${table.requestCount} > 0`,
    ),
    check(
      "embedding_batch_submissions_batch_attempt_check",
      sql`${table.batchAttempt} > 0`,
    ),
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
        | "gmail-control"
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
      sql`${table.queueName} in ('gmail-pages', 'gmail-messages', 'gmail-control', 'mail-indexing-batch', 'mail-indexing-live', 'mail-memory-submit', 'mail-memory-events', 'mail-memory-feedback')`,
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

export const gmailPushEvents = pgTable(
  "gmail_push_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: text("provider_event_id").notNull(),
    accountId: uuid("account_id").references(() => connectedAccounts.id, {
      onDelete: "set null",
    }),
    emailAddress: text("email_address").notNull(),
    notificationHistoryId: text("notification_history_id").notNull(),
    subscription: text("subscription").notNull(),
    publishedAt: timestampWithTimezone("published_at"),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    status: text("status")
      .$type<"stored" | "processed" | "failed">()
      .notNull()
      .default("stored"),
    processedAt: timestampWithTimezone("processed_at"),
    lastError: text("last_error"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("gmail_push_events_provider_event_idx").on(table.providerEventId),
    index("gmail_push_events_account_created_idx").on(table.accountId, table.createdAt),
    check(
      "gmail_push_events_status_check",
      sql`${table.status} in ('stored', 'processed', 'failed')`,
    ),
  ],
);

export const gmailReplicaAudits = pgTable(
  "gmail_replica_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    trigger: text("trigger")
      .$type<"initial" | "history_expired" | "watch_renewal" | "manual">()
      .notNull(),
    status: text("status")
      .$type<"running" | "complete" | "repairing" | "failed">()
      .notNull()
      .default("running"),
    providerMessageCount: integer("provider_message_count"),
    storedMessageCount: integer("stored_message_count"),
    missingMessageIds: jsonb("missing_message_ids").$type<string[]>().notNull().default([]),
    extraMessageIds: jsonb("extra_message_ids").$type<string[]>().notNull().default([]),
    details: jsonb("details").$type<JsonObject>().notNull().default({}),
    startedAt: timestampWithTimezone("started_at").notNull().defaultNow(),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimezone("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("gmail_replica_audits_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    check(
      "gmail_replica_audits_trigger_check",
      sql`${table.trigger} in ('initial', 'history_expired', 'watch_renewal', 'manual')`,
    ),
    check(
      "gmail_replica_audits_status_check",
      sql`${table.status} in ('running', 'complete', 'repairing', 'failed')`,
    ),
  ],
);

export const gmailAccountCleanups = pgTable(
  "gmail_account_cleanups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "complete" | "failed">()
      .notNull()
      .default("queued"),
    objectCount: integer("object_count"),
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
    uniqueIndex("gmail_account_cleanups_account_idx").on(table.accountId),
    index("gmail_account_cleanups_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    check(
      "gmail_account_cleanups_status_check",
      sql`${table.status} in ('queued', 'running', 'complete', 'failed')`,
    ),
    check(
      "gmail_account_cleanups_object_count_check",
      sql`${table.objectCount} is null or ${table.objectCount} >= 0`,
    ),
  ],
);

export const mailboxChangeEvents = pgTable(
  "mailbox_change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => connectedAccounts.id, { onDelete: "cascade" }),
    changeType: text("change_type")
      .$type<"replica_ready" | "history_applied" | "repair_complete" | "drafts_changed" | "labels_changed">()
      .notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull().default({}),
    createdAt: timestampWithTimezone("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("mailbox_change_events_account_created_idx").on(
      table.accountId,
      table.createdAt,
    ),
    check(
      "mailbox_change_events_type_check",
      sql`${table.changeType} in ('replica_ready', 'history_applied', 'repair_complete', 'drafts_changed', 'labels_changed')`,
    ),
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
