CREATE SCHEMA "vault";
--> statement-breakpoint
CREATE TABLE "vault"."condition_taxonomy" (
	"code" text PRIMARY KEY NOT NULL,
	"label_en" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "condition_taxonomy_code_check" CHECK ("vault"."condition_taxonomy"."code" ~ '^[a-z][a-z0-9_]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "vault"."disclosure_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vault_id" uuid NOT NULL,
	"viewer_account_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "disclosure_grants_scope_check" CHECK ("vault"."disclosure_grants"."scope" in ('full','conditions_only')),
	CONSTRAINT "disclosure_grants_revoked_after_granted" CHECK ("vault"."disclosure_grants"."revoked_at" is null or "vault"."disclosure_grants"."revoked_at" >= "vault"."disclosure_grants"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "vault"."filter_preferences" (
	"vault_id" uuid PRIMARY KEY NOT NULL,
	"payload_ct" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filter_preferences_version_check" CHECK ("vault"."filter_preferences"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "vault"."health_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"accessor" text NOT NULL,
	"purpose" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_access_log_accessor_check" CHECK ("vault"."health_access_log"."accessor" ~ '^((account|staff):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|service:[a-z][a-z0-9-]{0,39})$'),
	CONSTRAINT "health_access_log_purpose_check" CHECK ("vault"."health_access_log"."purpose" in ('profile_view','chat_card','moderation','export','erasure')),
	CONSTRAINT "health_access_log_decision_check" CHECK ("vault"."health_access_log"."decision" in ('allow','deny')),
	CONSTRAINT "health_access_log_reason_check" CHECK ("vault"."health_access_log"."reason" ~ '^[a-z][a-z0-9_]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "vault"."health_profiles" (
	"vault_id" uuid PRIMARY KEY NOT NULL,
	"payload_ct" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"visibility" text DEFAULT 'hidden' NOT NULL,
	"filter_opt_in" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_profiles_visibility_check" CHECK ("vault"."health_profiles"."visibility" in ('hidden','match_only','chat_grant','profile')),
	CONSTRAINT "health_profiles_version_check" CHECK ("vault"."health_profiles"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "vault"."subject_keys" (
	"vault_id" uuid PRIMARY KEY NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kms_key_arn" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vault"."subject_map" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_map_vault_id_unique" UNIQUE("vault_id")
);
--> statement-breakpoint
ALTER TABLE "vault"."disclosure_grants" ADD CONSTRAINT "disclosure_grants_vault_id_subject_map_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "vault"."subject_map"("vault_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."filter_preferences" ADD CONSTRAINT "filter_preferences_vault_id_subject_map_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "vault"."subject_map"("vault_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."health_profiles" ADD CONSTRAINT "health_profiles_vault_id_subject_map_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "vault"."subject_map"("vault_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."subject_keys" ADD CONSTRAINT "subject_keys_vault_id_subject_map_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "vault"."subject_map"("vault_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "disclosure_grants_active_unique" ON "vault"."disclosure_grants" USING btree ("vault_id","viewer_account_id") WHERE "vault"."disclosure_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "disclosure_grants_viewer_idx" ON "vault"."disclosure_grants" USING btree ("viewer_account_id");--> statement-breakpoint
CREATE INDEX "health_access_log_vault_at_idx" ON "vault"."health_access_log" USING btree ("vault_id","at");