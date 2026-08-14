ALTER TABLE "gmail_replica_states" DROP CONSTRAINT "gmail_replica_states_state_check";
--> statement-breakpoint
ALTER TABLE "labels" DROP CONSTRAINT "labels_description_check";
--> statement-breakpoint
DROP INDEX "labels_account_name_idx";
--> statement-breakpoint
DROP INDEX "labels_account_system_key_idx";
--> statement-breakpoint
ALTER TABLE "gmail_replica_states" ADD COLUMN "pending_history_cursor" text;
--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD COLUMN "run_type" text DEFAULT 'initial' NOT NULL;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "kind" text DEFAULT 'invook' NOT NULL;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "provider_label_id" text;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "provider_type" text;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "message_list_visibility" text;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "label_list_visibility" text;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "color" jsonb;
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "description" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "drafts" ALTER COLUMN "thread_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "kind" text DEFAULT 'invook' NOT NULL;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "provider_draft_id" text;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "provider_message_id" text;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "provider_thread_id" text;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "message_id" uuid;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "provider_history_id" text;
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "provider_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE "message_label_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "label_id" uuid NOT NULL,
  "ai_decision" text NOT NULL,
  "confidence" numeric(5, 2),
  "model_id" text,
  "definition_version" integer NOT NULL,
  "user_override" text,
  "analyzed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_label_decisions_ai_decision_check" CHECK ("ai_decision" in ('applied', 'not_applied')),
  CONSTRAINT "message_label_decisions_user_override_check" CHECK ("user_override" is null or "user_override" in ('applied', 'suppressed')),
  CONSTRAINT "message_label_decisions_confidence_check" CHECK ("confidence" is null or "confidence" between 0 and 100),
  CONSTRAINT "message_label_decisions_definition_version_check" CHECK ("definition_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "message_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "label_id" uuid NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_labels_source_check" CHECK ("source" in ('gmail', 'ai', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_label_decisions_message_label_idx" ON "message_label_decisions" ("message_id", "label_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "message_labels_message_label_idx" ON "message_labels" ("message_id", "label_id");
--> statement-breakpoint
INSERT INTO "labels" (
  "id",
  "user_id",
  "account_id",
  "kind",
  "provider_label_id",
  "name",
  "normalized_name",
  "description",
  "system_key",
  "definition_version",
  "analysis_state",
  "last_analyzed_at",
  "provider_type",
  "message_list_visibility",
  "label_list_visibility",
  "color",
  "provider_metadata",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "user_id",
  "account_id",
  'gmail',
  "provider_label_id",
  "name",
  lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g')),
  '',
  NULL,
  1,
  'complete',
  NULL,
  "type",
  "message_list_visibility",
  "label_list_visibility",
  "color",
  "provider_metadata",
  "created_at",
  "updated_at"
FROM "gmail_labels";
--> statement-breakpoint
INSERT INTO "message_labels" (
  "user_id",
  "account_id",
  "message_id",
  "label_id",
  "source",
  "created_at",
  "updated_at"
)
SELECT
  message."user_id",
  membership."account_id",
  membership."message_id",
  membership."gmail_label_id",
  'gmail',
  membership."created_at",
  membership."created_at"
FROM "gmail_message_labels" membership
INNER JOIN "messages" message ON message."id" = membership."message_id";
--> statement-breakpoint
INSERT INTO "message_label_decisions" (
  "user_id",
  "account_id",
  "message_id",
  "label_id",
  "ai_decision",
  "confidence",
  "model_id",
  "definition_version",
  "user_override",
  "analyzed_at"
)
SELECT
  message."user_id",
  analysis."account_id",
  message."id",
  analysis."label_id",
  CASE
    WHEN assignment."source" = 'ai' AND assignment."state" = 'applied' THEN 'applied'
    ELSE 'not_applied'
  END,
  CASE WHEN assignment."source" = 'ai' THEN assignment."confidence" ELSE NULL END,
  COALESCE(analysis."model_id", CASE WHEN assignment."source" = 'ai' THEN assignment."model_id" ELSE NULL END),
  analysis."definition_version",
  CASE
    WHEN assignment."source" = 'user' AND assignment."state" = 'applied' THEN 'applied'
    WHEN assignment."source" = 'user' AND assignment."state" = 'dismissed' THEN 'suppressed'
    ELSE NULL
  END,
  analysis."analyzed_at"
FROM "thread_label_analyses" analysis
INNER JOIN "messages" message ON message."thread_id" = analysis."thread_id"
LEFT JOIN "thread_labels" assignment
  ON assignment."thread_id" = analysis."thread_id"
 AND assignment."label_id" = analysis."label_id";
--> statement-breakpoint
INSERT INTO "message_label_decisions" (
  "user_id",
  "account_id",
  "message_id",
  "label_id",
  "ai_decision",
  "confidence",
  "model_id",
  "definition_version",
  "user_override",
  "analyzed_at"
)
SELECT
  message."user_id",
  assignment."account_id",
  message."id",
  assignment."label_id",
  CASE
    WHEN assignment."source" = 'ai' AND assignment."state" = 'applied' THEN 'applied'
    ELSE 'not_applied'
  END,
  CASE WHEN assignment."source" = 'ai' THEN assignment."confidence" ELSE NULL END,
  CASE WHEN assignment."source" = 'ai' THEN assignment."model_id" ELSE NULL END,
  label."definition_version",
  CASE
    WHEN assignment."source" = 'user' AND assignment."state" = 'applied' THEN 'applied'
    WHEN assignment."source" = 'user' AND assignment."state" = 'dismissed' THEN 'suppressed'
    ELSE NULL
  END,
  assignment."updated_at"
FROM "thread_labels" assignment
INNER JOIN "messages" message ON message."thread_id" = assignment."thread_id"
INNER JOIN "labels" label ON label."id" = assignment."label_id"
WHERE true
ON CONFLICT ("message_id", "label_id") DO UPDATE SET
  "ai_decision" = CASE
    WHEN EXCLUDED."user_override" IS NULL THEN EXCLUDED."ai_decision"
    ELSE "message_label_decisions"."ai_decision"
  END,
  "confidence" = CASE
    WHEN EXCLUDED."user_override" IS NULL THEN EXCLUDED."confidence"
    ELSE "message_label_decisions"."confidence"
  END,
  "model_id" = CASE
    WHEN EXCLUDED."user_override" IS NULL THEN EXCLUDED."model_id"
    ELSE "message_label_decisions"."model_id"
  END,
  "user_override" = COALESCE(EXCLUDED."user_override", "message_label_decisions"."user_override");
--> statement-breakpoint
INSERT INTO "message_labels" (
  "user_id",
  "account_id",
  "message_id",
  "label_id",
  "source",
  "created_at",
  "updated_at"
)
SELECT
  message."user_id",
  assignment."account_id",
  message."id",
  assignment."label_id",
  assignment."source",
  assignment."created_at",
  assignment."updated_at"
FROM "thread_labels" assignment
INNER JOIN "messages" message ON message."thread_id" = assignment."thread_id"
WHERE assignment."state" = 'applied'
ON CONFLICT ("message_id", "label_id") DO UPDATE SET
  "source" = EXCLUDED."source",
  "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
INSERT INTO "drafts" (
  "id",
  "user_id",
  "account_id",
  "kind",
  "thread_id",
  "provider_draft_id",
  "provider_message_id",
  "provider_thread_id",
  "message_id",
  "provider_history_id",
  "provider_metadata",
  "status",
  "generated_text",
  "current_text",
  "final_sent_text",
  "used_memory_ids",
  "generation_metadata",
  "edit_signals",
  "feedback_version",
  "last_feedback_at",
  "generated_at",
  "sent_at",
  "created_at",
  "updated_at"
)
SELECT
  provider_draft."id",
  provider_draft."user_id",
  provider_draft."account_id",
  'gmail',
  COALESCE(message."thread_id", thread."id"),
  provider_draft."provider_draft_id",
  provider_draft."provider_message_id",
  provider_draft."provider_thread_id",
  provider_draft."message_id",
  provider_draft."provider_history_id",
  provider_draft."provider_metadata",
  'editing',
  NULL,
  '',
  NULL,
  ARRAY[]::uuid[],
  '{}'::jsonb,
  '[]'::jsonb,
  0,
  NULL,
  NULL,
  NULL,
  provider_draft."created_at",
  provider_draft."updated_at"
FROM "gmail_drafts" provider_draft
LEFT JOIN "messages" message ON message."id" = provider_draft."message_id"
LEFT JOIN "threads" thread
  ON thread."account_id" = provider_draft."account_id"
 AND thread."provider_thread_id" = provider_draft."provider_thread_id";
--> statement-breakpoint
WITH highest_pending AS (
  SELECT DISTINCT ON ("account_id")
    "account_id",
    "notification_history_id"
  FROM "gmail_push_events"
  WHERE "account_id" IS NOT NULL
    AND "status" <> 'processed'
    AND "notification_history_id" ~ '^[0-9]+$'
  ORDER BY "account_id", ("notification_history_id")::numeric DESC
)
UPDATE "gmail_replica_states" replica
SET "pending_history_cursor" = highest."notification_history_id",
    "updated_at" = now()
FROM highest_pending highest
WHERE replica."account_id" = highest."account_id";
--> statement-breakpoint
INSERT INTO "workflow_steps" (
  "user_id",
  "account_id",
  "step_type",
  "status",
  "input",
  "attempts",
  "max_attempts",
  "idempotency_key"
)
SELECT
  account."user_id",
  replica."account_id",
  'gmail.history.catchup',
  'queued',
  '{"reason":"notification"}'::jsonb,
  0,
  5,
  'gmail-history-notification:' || replica."account_id"::text || ':' || replica."pending_history_cursor"
FROM "gmail_replica_states" replica
INNER JOIN "connected_accounts" account ON account."id" = replica."account_id"
WHERE replica."pending_history_cursor" IS NOT NULL
ON CONFLICT ("idempotency_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "workflow_steps" (
  "user_id",
  "account_id",
  "step_type",
  "status",
  "input",
  "attempts",
  "max_attempts",
  "idempotency_key"
)
SELECT
  tombstone."user_id",
  tombstone."account_id",
  'gmail.objects.delete',
  'queued',
  jsonb_build_object(
    'manifest',
    jsonb_build_object(
      'providerMessageId', tombstone."provider_message_id",
      'providerThreadId', tombstone."provider_thread_id",
      'providerHistoryId', tombstone."provider_history_id",
      'objectKeys', tombstone."object_keys"
    )
  ),
  0,
  10,
  'gmail-object-delete:migration:' || tombstone."id"::text
FROM "gmail_message_tombstones" tombstone
ON CONFLICT ("idempotency_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "queue_outbox" ("workflow_step_id", "queue_name")
SELECT step."id", 'gmail-control'
FROM "workflow_steps" step
WHERE step."step_type" IN ('gmail.history.catchup', 'gmail.objects.delete')
  AND step."status" IN ('queued', 'running')
ON CONFLICT ("workflow_step_id") DO NOTHING;
--> statement-breakpoint
DELETE FROM "queue_outbox" outbox
USING "workflow_steps" step
WHERE outbox."workflow_step_id" = step."id"
  AND step."step_type" IN ('gmail.replica.audit', 'gmail.action.execute');
--> statement-breakpoint
DELETE FROM "workflow_steps"
WHERE "step_type" IN ('gmail.replica.audit', 'gmail.action.execute');
--> statement-breakpoint
UPDATE "gmail_replica_states"
SET "state" = CASE
      WHEN "ready_at" IS NOT NULL AND "history_cursor" IS NOT NULL THEN 'ready'
      ELSE 'failed'
    END,
    "last_error" = CASE
      WHEN "ready_at" IS NOT NULL AND "history_cursor" IS NOT NULL THEN NULL
      ELSE 'Replica audit was superseded by durable repair synchronization.'
    END,
    "updated_at" = now()
WHERE "state" = 'auditing';
--> statement-breakpoint
ALTER TABLE "message_label_decisions" ADD CONSTRAINT "message_label_decisions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_label_decisions" ADD CONSTRAINT "message_label_decisions_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "connected_accounts"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_label_decisions" ADD CONSTRAINT "message_label_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_label_decisions" ADD CONSTRAINT "message_label_decisions_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "connected_accounts"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "message_label_decisions_label_version_idx" ON "message_label_decisions" ("label_id", "definition_version");
--> statement-breakpoint
CREATE INDEX "message_labels_account_label_idx" ON "message_labels" ("account_id", "label_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_account_provider_idx" ON "drafts" ("account_id", "provider_draft_id") WHERE "provider_draft_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "drafts_account_provider_thread_idx" ON "drafts" ("account_id", "provider_thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_provider_idx" ON "labels" ("account_id", "provider_label_id") WHERE "provider_label_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_invook_name_idx" ON "labels" ("account_id", "normalized_name") WHERE "kind" = 'invook';
--> statement-breakpoint
CREATE INDEX "labels_account_kind_idx" ON "labels" ("account_id", "kind", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX "labels_account_system_key_idx" ON "labels" ("account_id", "system_key") WHERE "kind" = 'invook' AND "system_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_check" CHECK ("kind" in ('gmail', 'invook'));
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind_contract_check" CHECK (("kind" = 'gmail' and "provider_draft_id" is not null and "provider_thread_id" is not null) or ("kind" = 'invook' and "thread_id" is not null and "provider_draft_id" is null and "provider_message_id" is null and "provider_thread_id" is null and "provider_history_id" is null));
--> statement-breakpoint
ALTER TABLE "gmail_replica_states" ADD CONSTRAINT "gmail_replica_states_state_check" CHECK ("state" in ('pending', 'snapshotting', 'replaying', 'ready', 'repairing', 'failed', 'deleting'));
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_kind_check" CHECK ("kind" in ('gmail', 'invook'));
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_kind_contract_check" CHECK (("kind" = 'gmail' and "provider_label_id" is not null and "provider_type" in ('system', 'user') and "system_key" is null) or ("kind" = 'invook' and "provider_label_id" is null and "provider_type" is null and char_length(btrim("description")) > 0));
--> statement-breakpoint
ALTER TABLE "mail_sync_runs" ADD CONSTRAINT "mail_sync_runs_type_check" CHECK ("run_type" in ('initial', 'repair'));
--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "kind" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "gmail_replica_states" DROP COLUMN "last_audit_at";
--> statement-breakpoint
DROP TABLE "mailbox_action_targets";
--> statement-breakpoint
DROP TABLE "mailbox_action_proposals";
--> statement-breakpoint
DROP TABLE "gmail_message_labels";
--> statement-breakpoint
DROP TABLE "thread_label_analyses";
--> statement-breakpoint
DROP TABLE "thread_labels";
--> statement-breakpoint
DROP TABLE "gmail_drafts";
--> statement-breakpoint
DROP TABLE "gmail_message_tombstones";
--> statement-breakpoint
DROP TABLE "gmail_push_events";
--> statement-breakpoint
DROP TABLE "gmail_replica_audits";
--> statement-breakpoint
DROP TABLE "audit_events";
--> statement-breakpoint
DROP TABLE "gmail_labels";
