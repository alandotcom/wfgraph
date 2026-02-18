ALTER TABLE "workflow_execution_events" DROP CONSTRAINT "workflow_execution_events_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_execution_events" DROP CONSTRAINT "workflow_execution_events_execution_id_workflow_executions_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" DROP CONSTRAINT "workflow_execution_logs_execution_id_workflow_executions_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_wait_states" DROP CONSTRAINT "workflow_wait_states_execution_id_workflow_executions_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_wait_states" DROP CONSTRAINT "workflow_wait_states_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD CONSTRAINT "workflow_execution_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;