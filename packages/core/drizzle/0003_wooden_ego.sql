DROP INDEX "workflow_executions_workflow_id_correlation_key_idx";--> statement-breakpoint
DROP INDEX "workflow_wait_states_run_id_idx";--> statement-breakpoint
DROP INDEX "workflow_executions_workflow_id_started_at_idx";--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_scoped_idx" ON "workflow_execution_events" USING btree ("workflow_id","created_at") WHERE "workflow_execution_events"."event_type" in ('run_not_started', 'cancel_not_delivered');--> statement-breakpoint
CREATE INDEX "workflow_executions_started_at_id_idx" ON "workflow_executions" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "workflow_executions_superseded_by_workflow_idx" ON "workflow_executions" USING btree ("workflow_id") WHERE "workflow_executions"."status" = 'superseded';--> statement-breakpoint
CREATE INDEX "workflow_executions_live_by_workflow_idx" ON "workflow_executions" USING btree ("workflow_id","started_at") WHERE "workflow_executions"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX "workflow_wait_states_waiting_by_workflow_idx" ON "workflow_wait_states" USING btree ("workflow_id") WHERE "workflow_wait_states"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_started_at_idx" ON "workflow_executions" USING btree ("workflow_id","started_at","id");