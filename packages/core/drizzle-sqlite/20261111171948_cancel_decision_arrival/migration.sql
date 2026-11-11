ALTER TABLE `workflow_cancel_decisions` ADD `event_name` text;--> statement-breakpoint
ALTER TABLE `workflow_cancel_decisions` ADD `entity_type` text;--> statement-breakpoint
ALTER TABLE `workflow_cancel_decisions` ADD `entity_id` text;--> statement-breakpoint
ALTER TABLE `workflow_cancel_decisions` ADD `entity_value` text;--> statement-breakpoint
ALTER TABLE `workflow_cancel_decisions` ADD `received_at` integer;--> statement-breakpoint
CREATE INDEX `cancel_decisions_entity_idx` ON `workflow_cancel_decisions` (`workflow_id`,`entity_type`,`entity_id`,`received_at`) WHERE "workflow_cancel_decisions"."entity_type" is not null;--> statement-breakpoint
CREATE INDEX `cancel_decisions_entity_value_idx` ON `workflow_cancel_decisions` (`workflow_id`,`entity_value`,`received_at`) WHERE "workflow_cancel_decisions"."entity_value" is not null;