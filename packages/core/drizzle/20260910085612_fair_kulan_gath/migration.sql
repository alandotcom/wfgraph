ALTER TABLE "workflow_executions" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "entity_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "termination_kind" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "termination_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "termination_reason" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "termination_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP COLUMN "cancel_requested_at";--> statement-breakpoint
CREATE INDEX "workflow_executions_in_flight_by_typed_entity_idx" ON "workflow_executions" ("workflow_id","entity_type","entity_id","run_mode") WHERE "status" in ('pending', 'running', 'waiting');--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_entity_identity_pair_check" CHECK (("entity_type" is null and "entity_id" is null) or ("entity_type" is not null and "entity_id" is not null));--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_termination_check" CHECK (("termination_kind" is null and "termination_requested_at" is null and "termination_reason" is null and "termination_node_id" is null) or ("termination_kind" = 'cancel' and "termination_requested_at" is not null and "termination_reason" is null and "termination_node_id" is null) or ("termination_kind" = 'exit' and "termination_requested_at" is not null and "termination_reason" in ('entity_condition_not_met', 'entity_not_found') and "termination_node_id" is not null));