PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_executions` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`workflow_version_id` text NOT NULL,
	`workflow_run_id` text UNIQUE,
	`status` text NOT NULL,
	`start_source` text NOT NULL,
	`delivery_id` text,
	`enqueued_at` integer,
	`run_mode` text DEFAULT 'live' NOT NULL,
	`start_event_name` text,
	`entity_value` text,
	`entity_type` text,
	`entity_id` text,
	`input` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`waiting_at` integer,
	`cancelled_at` integer,
	`completed_at` integer,
	`duration` text,
	`termination_kind` text,
	`termination_requested_at` integer,
	`termination_reason` text,
	`termination_node_id` text,
	`cancel_event_name` text,
	`cancel_payload` text,
	CONSTRAINT `fk_workflow_executions_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_executions_workflow_version_id_workflow_versions_id_fk` FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_executions_status_check" CHECK("status" in ('pending', 'running', 'waiting', 'completed', 'failed', 'canceled', 'exited', 'superseded')),
	CONSTRAINT "workflow_executions_entity_identity_pair_check" CHECK(("entity_type" is null and "entity_id" is null) or ("entity_type" is not null and "entity_id" is not null)),
	CONSTRAINT "workflow_executions_termination_check" CHECK(("termination_kind" is null and "termination_requested_at" is null and "termination_reason" is null and "termination_node_id" is null) or ("termination_kind" = 'cancel' and "termination_requested_at" is not null and "termination_reason" is null and "termination_node_id" is null) or ("termination_kind" = 'exit' and "termination_requested_at" is not null and "termination_reason" in ('entity_condition_not_met', 'entity_not_found') and "termination_node_id" is not null)),
	CONSTRAINT "workflow_executions_start_source_check" CHECK("start_source" in ('event', 'manual', 'schedule')),
	CONSTRAINT "workflow_executions_run_mode_check" CHECK("run_mode" in ('live', 'test')),
	CONSTRAINT "workflow_executions_input_json_check" CHECK("input" is null or json_valid("input")),
	CONSTRAINT "workflow_executions_output_json_check" CHECK("output" is null or json_valid("output")),
	CONSTRAINT "workflow_executions_cancel_payload_json_check" CHECK("cancel_payload" is null or json_valid("cancel_payload"))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_executions`(`id`, `workflow_id`, `workflow_version_id`, `workflow_run_id`, `status`, `start_source`, `delivery_id`, `enqueued_at`, `run_mode`, `start_event_name`, `entity_value`, `entity_type`, `entity_id`, `input`, `output`, `error`, `started_at`, `waiting_at`, `cancelled_at`, `completed_at`, `duration`, `termination_kind`, `termination_requested_at`, `termination_reason`, `termination_node_id`, `cancel_event_name`, `cancel_payload`) SELECT `id`, `workflow_id`, `workflow_version_id`, `workflow_run_id`, `status`, `start_source`, `delivery_id`, `enqueued_at`, `run_mode`, `start_event_name`, `entity_value`, `entity_type`, `entity_id`, `input`, `output`, `error`, `started_at`, `waiting_at`, `cancelled_at`, `completed_at`, `duration`, `termination_kind`, `termination_requested_at`, `termination_reason`, `termination_node_id`, `cancel_event_name`, `cancel_payload` FROM `workflow_executions`;--> statement-breakpoint
DROP TABLE `workflow_executions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_executions` RENAME TO `workflow_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_executions_workflow_id_delivery_id_uidx` ON `workflow_executions` (`workflow_id`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `executions_workflow_started_idx` ON `workflow_executions` (`workflow_id`,`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_started_idx` ON `workflow_executions` (`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_value`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_typed_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_type`,`entity_id`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_workflow_in_flight_version_started_idx` ON `workflow_executions` (`workflow_id`,`workflow_version_id`,`started_at`) WHERE "workflow_executions"."status" in ('pending', 'running', 'waiting');