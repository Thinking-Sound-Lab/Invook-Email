CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_connection_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "image" text;--> statement-breakpoint
WITH primary_google_accounts AS (
	SELECT DISTINCT ON ("user_id")
		"user_id",
		"provider_account_id",
		btrim("email") AS "email",
		"created_at",
		"updated_at"
	FROM "connected_accounts"
	WHERE "provider" = 'gmail'
		AND NULLIF(btrim("email"), '') IS NOT NULL
	ORDER BY "user_id", "created_at", "id"
)
UPDATE "profiles" AS profile
SET
	"email" = primary_account."email",
	"email_verified" = true,
	"display_name" = COALESCE(
		NULLIF(btrim(profile."display_name"), ''),
		primary_account."email"
	),
	"updated_at" = now()
FROM primary_google_accounts AS primary_account
WHERE profile."id" = primary_account."user_id";--> statement-breakpoint
WITH primary_google_accounts AS (
	SELECT DISTINCT ON ("user_id")
		"user_id",
		"provider_account_id",
		"created_at",
		"updated_at"
	FROM "connected_accounts"
	WHERE "provider" = 'gmail'
	ORDER BY "user_id", "created_at", "id"
)
INSERT INTO "auth_accounts" (
	"account_id",
	"provider_id",
	"user_id",
	"scope",
	"created_at",
	"updated_at"
)
SELECT
	"provider_account_id",
	'google',
	"user_id",
	'openid,email,profile',
	"created_at",
	"updated_at"
FROM primary_google_accounts;--> statement-breakpoint
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
ALTER TABLE "profiles" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connection_requests" ADD CONSTRAINT "gmail_connection_requests_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connection_requests" ADD CONSTRAINT "gmail_connection_requests_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_identity_idx" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_idx" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expiration_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_connection_requests_state_idx" ON "gmail_connection_requests" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "gmail_connection_requests_expiration_idx" ON "gmail_connection_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "gmail_connection_requests_user_idx" ON "gmail_connection_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_email_idx" ON "profiles" USING btree ("email");
