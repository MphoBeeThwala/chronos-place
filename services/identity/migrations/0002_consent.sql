CREATE TABLE "identity"."consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"consent_type" text NOT NULL,
	"policy_version" text NOT NULL,
	"granted" boolean NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "consent_records_type_check" CHECK (consent_type in ('terms', 'privacy', 'health_processing', 'marketing'))
);
--> statement-breakpoint
CREATE TABLE "identity"."vault_erasure_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."consent_records" ADD CONSTRAINT "consent_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_account_idx" ON "identity"."consent_records" USING btree ("account_id","recorded_at");--> statement-breakpoint
CREATE INDEX "vault_erasure_pending_idx" ON "identity"."vault_erasure_requests" USING btree ("completed_at","next_attempt_at");