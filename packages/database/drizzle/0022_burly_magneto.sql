ALTER TABLE "labels" DROP CONSTRAINT "labels_system_key_check";--> statement-breakpoint
ALTER TABLE "labels" DROP CONSTRAINT "labels_kind_contract_check";--> statement-breakpoint
DROP INDEX "labels_account_system_key_idx";--> statement-breakpoint
DELETE FROM "labels"
WHERE "kind" = 'invook' AND "system_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" DROP COLUMN "system_key";--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_kind_contract_check" CHECK (("labels"."kind" = 'gmail' and "labels"."provider_label_id" is not null and "labels"."provider_type" in ('system', 'user')) or ("labels"."kind" = 'invook' and "labels"."provider_label_id" is null and "labels"."provider_type" is null and char_length(btrim("labels"."description")) > 0));
