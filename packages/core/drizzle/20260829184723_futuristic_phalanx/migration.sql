ALTER TABLE "workflow_versions" ADD COLUMN "kind" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_versions" ALTER COLUMN "version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_kind_check" CHECK ("kind" in ('published', 'draft_snapshot'));