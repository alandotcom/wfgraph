DROP INDEX "workflow_versions_draft_snapshot_published_at_idx";--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "last_pinned_at" timestamp;--> statement-breakpoint
CREATE INDEX "workflow_versions_draft_snapshot_last_pinned_at_idx" ON "workflow_versions" ("last_pinned_at") WHERE "kind" = 'draft_snapshot';