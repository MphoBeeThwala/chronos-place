CREATE SCHEMA "profile";
--> statement-breakpoint
CREATE TABLE "profile"."preferences" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"age_min" smallint NOT NULL,
	"age_max" smallint NOT NULL,
	"max_distance_km" smallint NOT NULL,
	"intents" text[] NOT NULL,
	"genders" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_age_check" CHECK ("profile"."preferences"."age_min" >= 18 and "profile"."preferences"."age_max" <= 99 and "profile"."preferences"."age_min" <= "profile"."preferences"."age_max"),
	CONSTRAINT "preferences_distance_check" CHECK ("profile"."preferences"."max_distance_km" between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "profile"."profile_interests" (
	"account_id" uuid NOT NULL,
	"interest_id" text NOT NULL,
	CONSTRAINT "profile_interests_account_id_interest_id_pk" PRIMARY KEY("account_id","interest_id")
);
--> statement-breakpoint
CREATE TABLE "profile"."profile_prompts" (
	"account_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"prompt_id" text NOT NULL,
	"answer" text NOT NULL,
	CONSTRAINT "profile_prompts_account_id_position_pk" PRIMARY KEY("account_id","position"),
	CONSTRAINT "profile_prompts_account_prompt_key" UNIQUE("account_id","prompt_id"),
	CONSTRAINT "profile_prompts_position_check" CHECK ("profile"."profile_prompts"."position" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "profile"."profiles" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"intent" text NOT NULL,
	"gender" text,
	"pronouns" text,
	"area_label" text,
	"location" geography(Point, 4326), -- unquoted by hand: drizzle-kit quotes types it does not know (ADR-0023)
	"location_updated_at" timestamp with time zone,
	"private_mode" boolean DEFAULT false NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_intent_check" CHECK (intent in ('long_term', 'dating', 'friendship', 'open'))
);
--> statement-breakpoint
ALTER TABLE "profile"."preferences" ADD CONSTRAINT "preferences_account_id_profiles_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "profile"."profiles"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile"."profile_interests" ADD CONSTRAINT "profile_interests_account_id_profiles_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "profile"."profiles"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile"."profile_prompts" ADD CONSTRAINT "profile_prompts_account_id_profiles_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "profile"."profiles"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profiles_location_gix" ON "profile"."profiles" USING gist ("location");