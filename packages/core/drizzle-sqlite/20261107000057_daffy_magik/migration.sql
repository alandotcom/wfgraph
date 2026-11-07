CREATE INDEX `executions_workflow_version_idx` ON `workflow_executions` (`workflow_version_id`);--> statement-breakpoint
CREATE INDEX `executions_completed_idx` ON `workflow_executions` (`completed_at`) WHERE "workflow_executions"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX `versions_draft_snapshot_published_idx` ON `workflow_versions` (`published_at`) WHERE "workflow_versions"."kind" = 'draft_snapshot';--> statement-breakpoint
CREATE INDEX `workflows_published_version_idx` ON `workflows` (`published_version_id`);