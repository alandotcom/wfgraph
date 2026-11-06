CREATE TABLE "workflow_event_inbox" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	"connection_id" text,
	"idempotency_key" text,
	"received_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"settled_at" timestamp,
	CONSTRAINT "workflow_event_inbox_status_check" CHECK ("status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "workflow_event_inbox_settled_check" CHECK (("status" = 'pending' and "settled_at" is null and "error" is null) or ("status" = 'delivered' and "settled_at" is not null and "error" is null) or ("status" = 'failed' and "settled_at" is not null and "error" is not null)),
	CONSTRAINT "workflow_event_inbox_data_check" CHECK (jsonb_typeof("data") = 'object')
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" DROP CONSTRAINT "workflow_execution_schedule_run_execution_check";--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" ADD COLUMN "inbox_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_event_inbox_idempotency_uidx" ON "workflow_event_inbox" ("name",coalesce("connection_id", ''),"idempotency_key") WHERE "idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "workflow_event_inbox_pending_idx" ON "workflow_event_inbox" ("received_at","id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "workflow_event_inbox_settled_idx" ON "workflow_event_inbox" ("received_at") WHERE "status" <> 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_execution_schedule_inbox_uidx" ON "workflow_execution_schedule" ("inbox_id");--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" ADD CONSTRAINT "workflow_execution_schedule_1rpjXQCjTAIp_fkey" FOREIGN KEY ("inbox_id") REFERENCES "workflow_event_inbox"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" ADD CONSTRAINT "workflow_execution_schedule_subject_check" CHECK (("kind" = 'run' and "execution_id" is not null and "inbox_id" is null) or ("kind" = 'delivery' and "inbox_id" is not null and "execution_id" is null));