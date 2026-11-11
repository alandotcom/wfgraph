DROP INDEX "workflow_execution_logs_execution_id_idx";--> statement-breakpoint
DROP INDEX "workflow_executions_live_by_workflow_idx";--> statement-breakpoint
CREATE INDEX "workflow_executions_live_by_workflow_idx" ON "workflow_executions" ("workflow_id","started_at","id") WHERE "status" <> 'superseded';--> statement-breakpoint
DROP INDEX "workflow_wait_states_waiting_by_workflow_idx";--> statement-breakpoint
CREATE INDEX "workflow_wait_states_waiting_by_workflow_idx" ON "workflow_wait_states" ("workflow_id","id") WHERE "status" = 'waiting';--> statement-breakpoint
DROP INDEX "workflows_name_ci_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_name_ci_uidx" ON "workflows" (lower(("name")::text collate "C"));--> statement-breakpoint
CREATE INDEX "workflow_versions_draft_snapshot_digest_idx" ON "workflow_versions" ("workflow_id","graph_digest") WHERE "kind" = 'draft_snapshot';--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_completed_check" CHECK (("status" in ('completed', 'canceled', 'exited', 'superseded', 'failed')) = ("completed_at" is not null));--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_waiting_check" CHECK (("status" = 'waiting') = ("waiting_at" is not null));--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_cancelled_check" CHECK (("status" = 'canceled') = ("cancelled_at" is not null));