DROP INDEX "workflow_execution_schedule_lease_idx";--> statement-breakpoint
CREATE INDEX "workflow_execution_schedule_leased_idx" ON "workflow_execution_schedule" ("id") WHERE "state" = 'leased';