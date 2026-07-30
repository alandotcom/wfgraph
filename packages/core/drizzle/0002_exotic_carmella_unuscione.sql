ALTER TABLE "workflow_executions" ADD COLUMN "delivery_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "enqueued_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_workflow_id_delivery_id_uidx" ON "workflow_executions" USING btree ("workflow_id","delivery_id");