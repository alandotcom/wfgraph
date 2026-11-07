ALTER TABLE `workflow_versions` ADD `last_pinned_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `versions_draft_snapshot_published_idx`;--> statement-breakpoint
CREATE INDEX `versions_draft_snapshot_last_pinned_idx` ON `workflow_versions` (`last_pinned_at`) WHERE "workflow_versions"."kind" = 'draft_snapshot';