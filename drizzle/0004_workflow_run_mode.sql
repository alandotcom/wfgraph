ALTER TABLE "workflow_executions" ADD COLUMN "run_mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
UPDATE "workflow_executions"
SET "run_mode" = CASE
  WHEN "is_dry_run" = true THEN 'test'
  ELSE 'live'
END;--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP COLUMN "is_dry_run";
