CREATE SCHEMA "matching";
--> statement-breakpoint
CREATE TABLE "matching"."blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "blocks_not_self" CHECK ("matching"."blocks"."blocker_id" <> "matching"."blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "matching"."likes" (
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_from_id_to_id_pk" PRIMARY KEY("from_id","to_id"),
	CONSTRAINT "likes_kind_check" CHECK ("matching"."likes"."kind" in ('like', 'pass')),
	CONSTRAINT "likes_not_self" CHECK ("matching"."likes"."from_id" <> "matching"."likes"."to_id")
);
--> statement-breakpoint
CREATE TABLE "matching"."matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"a_id" uuid NOT NULL,
	"b_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "matches_ordered_pair" CHECK ("matching"."matches"."a_id" < "matching"."matches"."b_id"),
	CONSTRAINT "matches_status_check" CHECK ("matching"."matches"."status" in ('active', 'ended')),
	CONSTRAINT "matches_end_check" CHECK (("matching"."matches"."status" = 'active') = ("matching"."matches"."ended_at" is null and "matching"."matches"."ended_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "matching"."outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"partition_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "matching"."blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "likes_to_idx" ON "matching"."likes" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_pair_unique" ON "matching"."matches" USING btree ("a_id","b_id");--> statement-breakpoint
CREATE INDEX "matches_b_idx" ON "matching"."matches" USING btree ("b_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "matching"."outbox" USING btree ("published_at","next_attempt_at");