CREATE TABLE `workflow_execution_schedule` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`execution_id` text,
	`state` text NOT NULL,
	`wake_at` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`running_step_id` text,
	`lease_expires_at` integer,
	`owner_token` text,
	`worker_id` text,
	`last_error` text,
	CONSTRAINT `fk_workflow_execution_schedule_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_schedule_kind_check" CHECK("kind" in ('run', 'delivery')),
	CONSTRAINT "workflow_execution_schedule_state_check" CHECK("state" in ('queued', 'leased', 'waiting')),
	CONSTRAINT "workflow_execution_schedule_run_execution_check" CHECK("kind" <> 'run' or "execution_id" is not null)
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflow_execution_steps` (
	`schedule_id` text NOT NULL,
	`step_id` text NOT NULL,
	`status` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`value` text,
	`error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `workflow_execution_steps_pk` PRIMARY KEY(`schedule_id`, `step_id`),
	CONSTRAINT `fk_workflow_execution_steps_schedule_id_workflow_execution_schedule_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `workflow_execution_schedule`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_steps_status_check" CHECK("status" in ('succeeded', 'failing', 'failed')),
	CONSTRAINT "workflow_execution_steps_error_check" CHECK(("status" = 'succeeded') = ("error" is null)),
	CONSTRAINT "workflow_execution_steps_value_json_check" CHECK("value" is null or json_valid("value"))
) STRICT;
--> statement-breakpoint
ALTER TABLE `workflow_execution_logs` ADD `released_outlet` text;--> statement-breakpoint
ALTER TABLE `workflow_wait_states` ADD `park_step_id` text;--> statement-breakpoint
ALTER TABLE `workflow_wait_states` ADD `wake` text;--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_execution_uidx` ON `workflow_execution_schedule` (`execution_id`);--> statement-breakpoint
CREATE INDEX `schedule_due_idx` ON `workflow_execution_schedule` (`wake_at`,`id`) WHERE "workflow_execution_schedule"."state" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX `schedule_lease_idx` ON `workflow_execution_schedule` (`lease_expires_at`) WHERE "workflow_execution_schedule"."state" = 'leased';