CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_managed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_event_subscriptions" (
	"workflow_id" text NOT NULL,
	"event_name" text NOT NULL,
	"role" text NOT NULL,
	"correlation_path" text,
	CONSTRAINT "workflow_event_subscriptions_workflow_id_event_name_role_pk" PRIMARY KEY("workflow_id","event_name","role")
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"execution_id" text,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
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
	"started_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"completed_at" timestamp,
	"duration" text,
	"timestamp" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version_id" text NOT NULL,
	"workflow_run_id" text,
	"status" text NOT NULL,
	"start_source" text,
	"delivery_id" text,
	"enqueued_at" timestamp,
	"run_mode" text DEFAULT 'live' NOT NULL,
	"start_event_name" text,
	"entity_value" text,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"waiting_at" timestamp,
	"cancelled_at" timestamp,
	"completed_at" timestamp,
	"duration" text,
	"cancel_requested_at" timestamp,
	"cancel_event_name" text,
	"cancel_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"catalog_fingerprint" text NOT NULL,
	"graph_digest" text NOT NULL,
	"published_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
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
	"resume_token" text,
	"wait_until" timestamp,
	"subscribed_events" text[],
	"metadata" jsonb,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"resumed_at" timestamp,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"graph" jsonb NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"published_version_id" text,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"updated_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_event_subscriptions" ADD CONSTRAINT "workflow_event_subscriptions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_events" ADD CONSTRAINT "workflow_execution_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD CONSTRAINT "workflow_execution_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD CONSTRAINT "workflow_wait_states_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_published_version_id_workflow_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "workflow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "workflow_event_subscriptions_event_name_idx" ON "workflow_event_subscriptions" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_created_at_idx" ON "workflow_execution_events" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_execution_events_execution_created_at_idx" ON "workflow_execution_events" USING btree ("execution_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_execution_events_workflow_scoped_idx" ON "workflow_execution_events" USING btree ("workflow_id","created_at") WHERE "workflow_execution_events"."event_type" in ('run_refused', 'cancel_not_delivered');--> statement-breakpoint
CREATE INDEX "workflow_execution_logs_execution_id_idx" ON "workflow_execution_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "workflow_execution_logs_execution_id_timestamp_idx" ON "workflow_execution_logs" USING btree ("execution_id","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_workflow_run_id_uidx" ON "workflow_executions" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_executions_workflow_id_delivery_id_uidx" ON "workflow_executions" USING btree ("workflow_id","delivery_id");--> statement-breakpoint
CREATE INDEX "workflow_executions_workflow_id_started_at_idx" ON "workflow_executions" USING btree ("workflow_id","started_at","id");--> statement-breakpoint
CREATE INDEX "workflow_executions_started_at_id_idx" ON "workflow_executions" USING btree ("started_at","id");--> statement-breakpoint
CREATE INDEX "workflow_executions_superseded_by_workflow_idx" ON "workflow_executions" USING btree ("workflow_id") WHERE "workflow_executions"."status" = 'superseded';--> statement-breakpoint
CREATE INDEX "workflow_executions_live_by_workflow_idx" ON "workflow_executions" USING btree ("workflow_id","started_at") WHERE "workflow_executions"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX "workflow_executions_in_flight_by_entity_idx" ON "workflow_executions" USING btree ("workflow_id","entity_value","run_mode") WHERE "workflow_executions"."status" in ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_uidx" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_versions_workflow_id_published_at_idx" ON "workflow_versions" USING btree ("workflow_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_wait_states_resume_token_uidx" ON "workflow_wait_states" USING btree ("resume_token");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_execution_status_idx" ON "workflow_wait_states" USING btree ("execution_id","status");--> statement-breakpoint
CREATE INDEX "workflow_wait_states_subscribed_events_idx" ON "workflow_wait_states" USING gin ("subscribed_events") WHERE "workflow_wait_states"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "workflow_wait_states_waiting_by_workflow_idx" ON "workflow_wait_states" USING btree ("workflow_id") WHERE "workflow_wait_states"."status" = 'waiting';--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_name_ci_uidx" ON "workflows" USING btree (lower("name"));