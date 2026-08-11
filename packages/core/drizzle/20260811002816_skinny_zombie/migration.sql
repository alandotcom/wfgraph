DROP INDEX "workflow_execution_events_workflow_scoped_idx";--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_scoped_idx" ON "workflow_execution_events" ("workflow_id","created_at") WHERE "event_type" in ('run_refused', 'cancel_not_delivered');--> statement-breakpoint
DROP INDEX "workflow_executions_superseded_by_workflow_idx";--> statement-breakpoint
CREATE INDEX "workflow_executions_superseded_by_workflow_idx" ON "workflow_executions" ("workflow_id") WHERE "status" = 'superseded';--> statement-breakpoint
DROP INDEX "workflow_executions_live_by_workflow_idx";--> statement-breakpoint
CREATE INDEX "workflow_executions_live_by_workflow_idx" ON "workflow_executions" ("workflow_id","started_at") WHERE "status" <> 'superseded';--> statement-breakpoint
DROP INDEX "workflow_executions_in_flight_by_entity_idx";--> statement-breakpoint
CREATE INDEX "workflow_executions_in_flight_by_entity_idx" ON "workflow_executions" ("workflow_id","entity_value","run_mode") WHERE "status" in ('pending', 'running', 'waiting');--> statement-breakpoint
DROP INDEX "workflow_wait_states_subscribed_events_idx";--> statement-breakpoint
CREATE INDEX "workflow_wait_states_subscribed_events_idx" ON "workflow_wait_states" USING gin ("subscribed_events") WHERE "status" = 'waiting';--> statement-breakpoint
DROP INDEX "workflow_wait_states_waiting_by_workflow_idx";--> statement-breakpoint
CREATE INDEX "workflow_wait_states_waiting_by_workflow_idx" ON "workflow_wait_states" ("workflow_id") WHERE "status" = 'waiting';