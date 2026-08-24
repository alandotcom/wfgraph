CREATE TABLE "oauth_authorization_attempts" (
	"state_hash" text PRIMARY KEY,
	"integration_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "config_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "refresh_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "refresh_claim_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "refresh_claimed_at" timestamp;--> statement-breakpoint
CREATE INDEX "oauth_authorization_attempts_integration_id_idx" ON "oauth_authorization_attempts" ("integration_id");--> statement-breakpoint
CREATE INDEX "oauth_authorization_attempts_expires_at_idx" ON "oauth_authorization_attempts" ("expires_at");--> statement-breakpoint
ALTER TABLE "oauth_authorization_attempts" ADD CONSTRAINT "oauth_authorization_attempts_AYZ26r2NZKvL_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE;