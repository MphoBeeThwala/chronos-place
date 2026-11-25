CREATE TABLE "profile"."photo_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_uploads_length_check" CHECK ("profile"."photo_uploads"."byte_length" between 1 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "profile"."profile_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"moderation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_photos_position_check" CHECK ("profile"."profile_photos"."position" between 0 and 5),
	CONSTRAINT "profile_photos_moderation_check" CHECK (moderation in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "profile"."photo_uploads" ADD CONSTRAINT "photo_uploads_account_id_profiles_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "profile"."profiles"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile"."profile_photos" ADD CONSTRAINT "profile_photos_account_id_profiles_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "profile"."profiles"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_uploads_account_idx" ON "profile"."photo_uploads" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "profile_photos_account_idx" ON "profile"."profile_photos" USING btree ("account_id","position");