CREATE TABLE "identity"."deletion_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."erasure_confirmations" (
	"account_id" uuid NOT NULL,
	"service" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "erasure_confirmations_account_id_service_pk" PRIMARY KEY("account_id","service")
);
--> statement-breakpoint
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_status_check";--> statement-breakpoint
ALTER TABLE "identity"."accounts" ALTER COLUMN "phone_lookup" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."accounts" ALTER COLUMN "phone_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."accounts" ALTER COLUMN "phone_nonce" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."accounts" ADD COLUMN "erasure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."accounts" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."deletion_challenges" ADD CONSTRAINT "deletion_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."erasure_confirmations" ADD CONSTRAINT "erasure_confirmations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "identity"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deletion_challenges_account_idx" ON "identity"."deletion_challenges" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "identity"."accounts" ADD CONSTRAINT "accounts_erased_is_empty" CHECK ("identity"."accounts"."status" <> 'erased' or ("identity"."accounts"."phone_lookup" is null and "identity"."accounts"."phone_ciphertext" is null and "identity"."accounts"."phone_nonce" is null and "identity"."accounts"."date_of_birth" is null and "identity"."accounts"."verified_at" is null));--> statement-breakpoint
ALTER TABLE "identity"."accounts" ADD CONSTRAINT "accounts_status_check" CHECK (status in ('pending_onboarding', 'active', 'ineligible', 'suspended', 'pending_erasure', 'erased'));