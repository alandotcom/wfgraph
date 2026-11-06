DROP INDEX "workflow_executions_workflow_run_id_uidx";--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP COLUMN "workflow_run_id";--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP COLUMN "enqueued_at";--> statement-breakpoint
ALTER TABLE "workflow_wait_states" DROP COLUMN "run_id";