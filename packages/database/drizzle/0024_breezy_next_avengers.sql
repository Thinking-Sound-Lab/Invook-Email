WITH primary_google_accounts AS (
	SELECT DISTINCT ON ("user_id")
		"user_id",
		btrim("email") AS "email"
	FROM "connected_accounts"
	WHERE "provider" = 'gmail'
		AND NULLIF(btrim("email"), '') IS NOT NULL
	ORDER BY "user_id", "created_at", "id"
)
UPDATE "profiles" AS profile
SET
	"email" = COALESCE(NULLIF(btrim(profile."email"), ''), primary_account."email"),
	"display_name" = COALESCE(
		NULLIF(btrim(profile."display_name"), ''),
		NULLIF(btrim(profile."email"), ''),
		primary_account."email"
	),
	"updated_at" = now()
FROM primary_google_accounts AS primary_account
WHERE profile."id" = primary_account."user_id"
	AND (
		NULLIF(btrim(profile."email"), '') IS NULL
		OR NULLIF(btrim(profile."display_name"), '') IS NULL
	);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "profiles"
		WHERE NULLIF(btrim("email"), '') IS NULL
			OR NULLIF(btrim("display_name"), '') IS NULL
	) THEN
		RAISE EXCEPTION 'Cannot enforce Better Auth user requirements: profiles contain unresolved email or display_name values';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "email" SET NOT NULL;
