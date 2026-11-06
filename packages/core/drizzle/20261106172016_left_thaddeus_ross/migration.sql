ALTER TABLE "workflow_execution_logs" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" ADD COLUMN "running_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" ADD COLUMN "node_id" text;