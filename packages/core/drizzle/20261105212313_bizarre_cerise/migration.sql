CREATE TABLE "workflow_execution_schedule" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"execution_id" text,
	"state" text NOT NULL,
	"wake_at" timestamp NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"running_step_id" text,
	"lease_expires_at" timestamp,
	"owner_token" text,
	"worker_id" text,
	"last_error" text,
	CONSTRAINT "workflow_execution_schedule_kind_check" CHECK ("kind" in ('run', 'delivery')),
	CONSTRAINT "workflow_execution_schedule_state_check" CHECK ("state" in ('queued', 'leased', 'waiting')),
	CONSTRAINT "workflow_execution_schedule_run_execution_check" CHECK ("kind" <> 'run' or "execution_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_steps" (
	"schedule_id" text,
	"step_id" text,
	"status" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"value" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "workflow_execution_steps_pkey" PRIMARY KEY("schedule_id","step_id"),
	CONSTRAINT "workflow_execution_steps_status_check" CHECK ("status" in ('succeeded', 'failing', 'failed')),
	CONSTRAINT "workflow_execution_steps_error_check" CHECK (("status" = 'succeeded') = ("error" is null))
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "released_outlet" text;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD COLUMN "park_step_id" text;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD COLUMN "wake" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_execution_schedule_execution_uidx" ON "workflow_execution_schedule" ("execution_id");--> statement-breakpoint
CREATE INDEX "workflow_execution_schedule_due_idx" ON "workflow_execution_schedule" ("wake_at","id") WHERE "state" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX "workflow_execution_schedule_lease_idx" ON "workflow_execution_schedule" ("lease_expires_at") WHERE "state" = 'leased';--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" ADD CONSTRAINT "workflow_execution_schedule_ol1DMxImd6nF_fkey" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_OTqafp6eqJgr_fkey" FOREIGN KEY ("schedule_id") REFERENCES "workflow_execution_schedule"("id") ON DELETE CASCADE;