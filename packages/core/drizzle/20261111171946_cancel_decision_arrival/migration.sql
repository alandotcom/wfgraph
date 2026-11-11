ALTER TABLE "workflow_cancel_decisions" ADD COLUMN "event_name" text;--> statement-breakpoint
ALTER TABLE "workflow_cancel_decisions" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "workflow_cancel_decisions" ADD COLUMN "entity_id" text;--> statement-breakpoint
ALTER TABLE "workflow_cancel_decisions" ADD COLUMN "entity_value" text;--> statement-breakpoint
ALTER TABLE "workflow_cancel_decisions" ADD COLUMN "received_at" timestamp;--> statement-breakpoint
CREATE INDEX "workflow_cancel_decisions_entity_idx" ON "workflow_cancel_decisions" ("workflow_id","entity_type","entity_id","received_at") WHERE "entity_type" is not null;--> statement-breakpoint
CREATE INDEX "workflow_cancel_decisions_entity_value_idx" ON "workflow_cancel_decisions" ("workflow_id","entity_value","received_at") WHERE "entity_value" is not null;