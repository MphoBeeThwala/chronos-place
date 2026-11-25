CREATE TABLE "identity"."verification_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"outcome" text NOT NULL,
	"failure" text,
	"job_ciphertext" "bytea",
	"job_nonce" "bytea",
	"capture_key" text,
	"next_check_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone,
	"review_requested_at" timestamp with time zone,
	"purge_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_attempts_outcome_check" CHECK (outcome in ('pending', 'passed', 'failed', 'unavailable')),
	CONSTRAINT "verification_attempts_failure_check" CHECK (failure is null or failure in ('poor_quality', 'not_confirmed'))
);
--> statement-breakpoint
ALTER TABLE "identity"."consent_records" DROP CONSTRAINT "consent_records_type_check";--> statement-breakpoint
ALTER TABLE "identity"."verification_attempts" ADD CONSTRAINT "verification_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_attempts_account_idx" ON "identity"."verification_attempts" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_attempts_check_idx" ON "identity"."verification_attempts" USING btree ("outcome","next_check_at");--> statement-breakpoint
CREATE INDEX "verification_attempts_capture_idx" ON "identity"."verification_attempts" USING btree ("created_at") WHERE capture_key is not null;--> statement-breakpoint
ALTER TABLE "identity"."consent_records" ADD CONSTRAINT "consent_records_type_check" CHECK (consent_type in ('terms', 'privacy', 'health_processing', 'marketing', 'biometric_verification'));