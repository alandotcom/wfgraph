CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_managed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"execution_id" text,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_name" text NOT NULL,
	"node_type" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration" text,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_run_id" text,
	"status" text NOT NULL,
	"trigger_type" text,
	"is_dry_run" boolean DEFAULT false NOT NULL,
	"trigger_event_type" text,
	"correlation_key" text,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"waiting_at" timestamp,
	"cancelled_at" timestamp,
	"completed_at" timestamp,
	"duration" text
);
--> statement-breakpoint
CREATE TABLE "workflow_wait_states" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"workflow_id" text NOT NULL,
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
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"nodes" jsonb NOT NULL,
	"edges" jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD CONSTRAINT "workflow_execution_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_created_at_idx" ON "workflow_execution_events" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_execution_events_execution_created_at_idx" ON "workflow_execution_events" USING btree ("execution_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_workflow_run_id_uidx" ON "workflow_executions" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_started_at_idx" ON "workflow_executions" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_correlation_key_idx" ON "workflow_executions" USING btree ("workflow_id","correlation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_wait_states_hook_token_uidx" ON "workflow_wait_states" USING btree ("hook_token");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_execution_status_idx" ON "workflow_wait_states" USING btree ("execution_id","status");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_workflow_correlation_status_idx" ON "workflow_wait_states" USING btree ("workflow_id","correlation_key","status");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_run_id_idx" ON "workflow_wait_states" USING btree ("run_id");