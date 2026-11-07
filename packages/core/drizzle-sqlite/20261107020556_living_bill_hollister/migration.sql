ALTER TABLE `workflow_execution_schedule` ADD `workflow_id` text REFERENCES workflows(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `workflow_execution_schedule` ADD `cron` text;--> statement-breakpoint
ALTER TABLE `workflow_execution_schedule` ADD `time_zone` text;--> statement-breakpoint
ALTER TABLE `workflow_executions` ADD `scheduled_for` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_execution_schedule` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`execution_id` text,
	`inbox_id` text,
	`workflow_id` text,
	`cron` text,
	`time_zone` text,
	`state` text NOT NULL,
	`wake_at` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`running_step_id` text,
	`running_node_id` text,
	`lease_expires_at` integer,
	`owner_token` text,
	`worker_id` text,
	`last_error` text,
	CONSTRAINT `fk_workflow_execution_schedule_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_execution_schedule_inbox_id_workflow_event_inbox_id_fk` FOREIGN KEY (`inbox_id`) REFERENCES `workflow_event_inbox`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_execution_schedule_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_schedule_kind_check" CHECK("kind" in ('run', 'delivery', 'cron')),
	CONSTRAINT "workflow_execution_schedule_state_check" CHECK("state" in ('queued', 'leased', 'waiting')),
	CONSTRAINT "workflow_execution_schedule_subject_check" CHECK(("kind" = 'run' and "execution_id" is not null and "inbox_id" is null and "workflow_id" is null and "cron" is null and "time_zone" is null) or ("kind" = 'delivery' and "inbox_id" is not null and "execution_id" is null and "workflow_id" is null and "cron" is null and "time_zone" is null) or ("kind" = 'cron' and "workflow_id" is not null and "cron" is not null and "time_zone" is not null and "execution_id" is null and "inbox_id" is null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_execution_schedule`(`id`, `kind`, `execution_id`, `inbox_id`, `state`, `wake_at`, `attempt`, `running_step_id`, `running_node_id`, `lease_expires_at`, `owner_token`, `worker_id`, `last_error`) SELECT `id`, `kind`, `execution_id`, `inbox_id`, `state`, `wake_at`, `attempt`, `running_step_id`, `running_node_id`, `lease_expires_at`, `owner_token`, `worker_id`, `last_error` FROM `workflow_execution_schedule`;--> statement-breakpoint
DROP TABLE `workflow_execution_schedule`;--> statement-breakpoint
ALTER TABLE `__new_workflow_execution_schedule` RENAME TO `workflow_execution_schedule`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_execution_uidx` ON `workflow_execution_schedule` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_inbox_uidx` ON `workflow_execution_schedule` (`inbox_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_cron_uidx` ON `workflow_execution_schedule` (`workflow_id`,`cron`,`time_zone`);--> statement-breakpoint
CREATE INDEX `schedule_due_idx` ON `workflow_execution_schedule` (`wake_at`,`id`) WHERE "workflow_execution_schedule"."state" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX `schedule_lease_idx` ON `workflow_execution_schedule` (`lease_expires_at`) WHERE "workflow_execution_schedule"."state" = 'leased';