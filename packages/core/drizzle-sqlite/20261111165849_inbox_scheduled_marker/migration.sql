ALTER TABLE `workflow_event_inbox` ADD `scheduled_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `inbox_pending_idx`;--> statement-breakpoint
CREATE INDEX `inbox_unscheduled_idx` ON `workflow_event_inbox` (`received_at`,`id`) WHERE "workflow_event_inbox"."status" = 'pending' and "workflow_event_inbox"."scheduled_at" is null;