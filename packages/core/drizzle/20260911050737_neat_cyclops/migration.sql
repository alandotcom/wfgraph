ALTER TABLE "workflow_execution_events" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "workflow_execution_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
DROP INDEX "workflow_execution_events_workflow_created_at_idx";--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_created_at_idx" ON "workflow_execution_events" ("workflow_id","created_at","seq");--> statement-breakpoint
DROP INDEX "workflow_execution_events_execution_created_at_idx";--> statement-breakpoint
CREATE INDEX "workflow_execution_events_execution_created_at_idx" ON "workflow_execution_events" ("execution_id","created_at","seq");--> statement-breakpoint
DROP INDEX "workflow_execution_events_workflow_type_created_at_idx";--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_type_created_at_idx" ON "workflow_execution_events" ("workflow_id","event_type","created_at","seq");