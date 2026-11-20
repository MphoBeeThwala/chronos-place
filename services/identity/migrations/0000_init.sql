CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE TABLE "identity"."account_keys" (
	"subject_id" uuid PRIMARY KEY NOT NULL,
	"wrapped" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_lookup" "bytea" NOT NULL,
	"phone_ciphertext" "bytea" NOT NULL,
	"phone_nonce" "bytea" NOT NULL,
	"status" text NOT NULL,
	"date_of_birth" date,
	"verified_at" timestamp with time zone,
	"locale" text DEFAULT 'en-ZA' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_phone_lookup_unique" UNIQUE("phone_lookup"),
	CONSTRAINT "accounts_status_check" CHECK (status in ('pending_onboarding', 'active', 'ineligible', 'suspended', 'pending_erasure'))
);
--> statement-breakpoint
CREATE TABLE "identity"."otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_lookup" "bytea" NOT NULL,
	"prospective_account_id" uuid NOT NULL,
	"phone_ciphertext" "bytea" NOT NULL,
	"phone_nonce" "bytea" NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"device_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "identity"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_challenges_phone_lookup_idx" ON "identity"."otp_challenges" USING btree ("phone_lookup","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_expires_at_idx" ON "identity"."otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_id_idx" ON "identity"."refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_account_id_idx" ON "identity"."sessions" USING btree ("account_id");