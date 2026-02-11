CREATE TABLE "workflow_execution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"execution_id" text,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_wait_states" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_name" text NOT NULL,
	"wait_type" text NOT NULL,
	"status" text NOT NULL,
	"hook_token" text,
	"wait_until" timestamp,
	"correlation_key" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resumed_at" timestamp,
	"cancelled_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "trigger_type" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "trigger_event_type" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "correlation_key" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "waiting_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_created_at_idx" ON "workflow_execution_events" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_execution_events_execution_created_at_idx" ON "workflow_execution_events" USING btree ("execution_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_wait_states_hook_token_uidx" ON "workflow_wait_states" USING btree ("hook_token");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_execution_status_idx" ON "workflow_wait_states" USING btree ("execution_id","status");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_workflow_correlation_status_idx" ON "workflow_wait_states" USING btree ("workflow_id","correlation_key","status");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_run_id_idx" ON "workflow_wait_states" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_workflow_run_id_uidx" ON "workflow_executions" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_started_at_idx" ON "workflow_executions" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_correlation_key_idx" ON "workflow_executions" USING btree ("workflow_id","correlation_key");