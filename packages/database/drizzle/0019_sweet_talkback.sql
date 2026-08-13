ALTER TABLE "messages" ADD COLUMN "embedding_content_hash" text;--> statement-breakpoint
UPDATE "messages"
SET "embedding_content_hash" = coalesce(
	(
		SELECT "message_embeddings"."content_hash"
		FROM "message_embeddings"
		WHERE "message_embeddings"."message_id" = "messages"."id"
		ORDER BY
			CASE "message_embeddings"."status"
				WHEN 'complete' THEN 0
				WHEN 'submitted' THEN 1
				ELSE 2
			END,
			"message_embeddings"."updated_at" DESC
		LIMIT 1
	),
	encode(
		sha256(
			convert_to(
				btrim("messages"."subject") || E'\n' || btrim("messages"."body_text"),
				'UTF8'
			)
		),
		'hex'
	)
);--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "embedding_content_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_embedding_content_hash_check" CHECK ("messages"."embedding_content_hash" ~ '^[0-9a-f]{64}$');
