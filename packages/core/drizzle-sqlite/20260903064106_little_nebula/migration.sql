DROP INDEX IF EXISTS `events_workflow_created_idx`;--> statement-breakpoint
CREATE INDEX `events_workflow_type_created_idx` ON `workflow_execution_events` (`workflow_id`,`event_type`,`created_at` DESC);
