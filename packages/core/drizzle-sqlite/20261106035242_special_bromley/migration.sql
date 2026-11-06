CREATE TABLE `workflow_event_inbox` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
	`name` text NOT NULL,
	`data` text NOT NULL,
	`connection_id` text,
	`idempotency_key` text,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`settled_at` integer,
	CONSTRAINT "workflow_event_inbox_status_check" CHECK("status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "workflow_event_inbox_settled_check" CHECK(("status" = 'pending' and "settled_at" is null and "error" is null) or ("status" = 'delivered' and "settled_at" is not null and "error" is null) or ("status" = 'failed' and "settled_at" is not null and "error" is not null)),
	CONSTRAINT "workflow_event_inbox_data_json_check" CHECK(json_valid("data") and json_type("data") = 'object')
) STRICT;
--> statement-breakpoint
ALTER TABLE `workflow_execution_schedule` ADD `inbox_id` text REFERENCES workflow_event_inbox(id) ON DELETE CASCADE;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_execution_schedule` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`execution_id` text,
	`inbox_id` text,
	`state` text NOT NULL,
	`wake_at` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`running_step_id` text,
	`lease_expires_at` integer,
	`owner_token` text,
	`worker_id` text,
	`last_error` text,
	CONSTRAINT `fk_workflow_execution_schedule_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_execution_schedule_inbox_id_workflow_event_inbox_id_fk` FOREIGN KEY (`inbox_id`) REFERENCES `workflow_event_inbox`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_schedule_kind_check" CHECK("kind" in ('run', 'delivery')),
	CONSTRAINT "workflow_execution_schedule_state_check" CHECK("state" in ('queued', 'leased', 'waiting')),
	CONSTRAINT "workflow_execution_schedule_subject_check" CHECK(("kind" = 'run' and "execution_id" is not null and "inbox_id" is null) or ("kind" = 'delivery' and "inbox_id" is not null and "execution_id" is null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_execution_schedule`(`id`, `kind`, `execution_id`, `state`, `wake_at`, `attempt`, `running_step_id`, `lease_expires_at`, `owner_token`, `worker_id`, `last_error`) SELECT `id`, `kind`, `execution_id`, `state`, `wake_at`, `attempt`, `running_step_id`, `lease_expires_at`, `owner_token`, `worker_id`, `last_error` FROM `workflow_execution_schedule`;--> statement-breakpoint
DROP TABLE `workflow_execution_schedule`;--> statement-breakpoint
ALTER TABLE `__new_workflow_execution_schedule` RENAME TO `workflow_execution_schedule`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_execution_uidx` ON `workflow_execution_schedule` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_inbox_uidx` ON `workflow_execution_schedule` (`inbox_id`);--> statement-breakpoint
CREATE INDEX `schedule_due_idx` ON `workflow_execution_schedule` (`wake_at`,`id`) WHERE "workflow_execution_schedule"."state" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX `schedule_lease_idx` ON `workflow_execution_schedule` (`lease_expires_at`) WHERE "workflow_execution_schedule"."state" = 'leased';--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_idempotency_uidx` ON `workflow_event_inbox` (`name`,coalesce("connection_id", ''),`idempotency_key`) WHERE "workflow_event_inbox"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX `inbox_pending_idx` ON `workflow_event_inbox` (`received_at`,`id`) WHERE "workflow_event_inbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `inbox_settled_idx` ON `workflow_event_inbox` (`received_at`) WHERE "workflow_event_inbox"."status" <> 'pending';