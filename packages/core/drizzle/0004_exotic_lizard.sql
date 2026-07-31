ALTER TABLE "workflow_executions" RENAME COLUMN "trigger_event_type" TO "start_event_name";--> statement-breakpoint
ALTER TABLE "workflow_executions" RENAME COLUMN "correlation_key" TO "entity_value";--> statement-breakpoint
DROP INDEX "workflow_executions_in_flight_by_correlation_idx";--> statement-breakpoint
DROP INDEX "workflow_execution_events_workflow_scoped_idx";--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "created_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "created_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "updated_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ALTER COLUMN "created_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ALTER COLUMN "started_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ALTER COLUMN "timestamp" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflow_executions" ALTER COLUMN "started_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ALTER COLUMN "created_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "created_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "updated_at" SET DEFAULT (now() at time zone 'utc');--> statement-breakpoint
CREATE INDEX "workflow_executions_in_flight_by_entity_idx" ON "workflow_executions" USING btree ("workflow_id","entity_value","run_mode") WHERE "workflow_executions"."status" in ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_scoped_idx" ON "workflow_execution_events" USING btree ("workflow_id","created_at") WHERE "workflow_execution_events"."event_type" in ('run_refused', 'cancel_not_delivered');