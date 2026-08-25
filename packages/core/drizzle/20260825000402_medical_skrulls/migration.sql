ALTER TABLE "oauth_authorization_attempts" ADD COLUMN "mode" text DEFAULT 'reconnect' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_attempts" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_attempts" ADD COLUMN "result_integration_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_attempts" ADD COLUMN "updated_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_attempts" ADD CONSTRAINT "oauth_authorization_attempts_mode_check" CHECK ("mode" in ('create', 'reconnect'));--> statement-breakpoint
ALTER TABLE "oauth_authorization_attempts" ADD CONSTRAINT "oauth_authorization_attempts_status_check" CHECK ("status" in ('pending', 'processing', 'succeeded', 'failed'));