DROP INDEX "workflow_event_inbox_pending_idx";--> statement-breakpoint
ALTER TABLE "workflow_event_inbox" ADD COLUMN "scheduled_at" timestamp;--> statement-breakpoint
CREATE INDEX "workflow_event_inbox_unscheduled_idx" ON "workflow_event_inbox" ("received_at","id") WHERE "status" = 'pending' and "scheduled_at" is null;