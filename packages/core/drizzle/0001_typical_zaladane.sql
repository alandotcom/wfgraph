ALTER TABLE "workflow_executions" ADD COLUMN "cancel_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "cancel_event_name" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "cancel_payload" jsonb;