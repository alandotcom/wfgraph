CREATE TABLE "workflow_execution_schedule" (
	"execution_id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"wake_at" timestamp NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp,
	"owner_token" text,
	"worker_id" text,
	"last_error" text,
	CONSTRAINT "workflow_execution_schedule_kind_check" CHECK ("kind" in ('run', 'delivery')),
	CONSTRAINT "workflow_execution_schedule_state_check" CHECK ("state" in ('queued', 'leased', 'waiting'))
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_steps" (
	"execution_id" text,
	"step_id" text,
	"attempt" integer NOT NULL,
	"value" jsonb,
	"created_at" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	CONSTRAINT "workflow_execution_steps_pkey" PRIMARY KEY("execution_id","step_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "released_outlet" text;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD COLUMN "park_step_id" text;--> statement-breakpoint
ALTER TABLE "workflow_wait_states" ADD COLUMN "wake" jsonb;--> statement-breakpoint
CREATE INDEX "workflow_execution_schedule_due_idx" ON "workflow_execution_schedule" ("wake_at","execution_id") WHERE "state" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX "workflow_execution_schedule_lease_idx" ON "workflow_execution_schedule" ("lease_expires_at") WHERE "state" = 'leased';--> statement-breakpoint
ALTER TABLE "workflow_execution_schedule" ADD CONSTRAINT "workflow_execution_schedule_ol1DMxImd6nF_fkey" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_iMIOYERAsOxz_fkey" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE;