-- Drizzle Kit cannot yet express SQLite STRICT tables or descending index
-- columns. The rebuild below keeps both as the table had them.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_integrations` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`is_managed` integer DEFAULT 0,
	`refresh_state` text DEFAULT 'idle' NOT NULL,
	`config_revision` integer DEFAULT 0 NOT NULL,
	`refresh_claim_id` text,
	`refresh_claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "integrations_is_managed_check" CHECK("is_managed" is null or "is_managed" in (0, 1)),
	CONSTRAINT "integrations_refresh_state_check" CHECK("refresh_state" in ('idle', 'refreshing', 'reauthorization_required')),
	CONSTRAINT "integrations_refresh_claim_check" CHECK(("refresh_state" = 'refreshing' and "refresh_claim_id" is not null and "refresh_claimed_at" is not null) or ("refresh_state" <> 'refreshing' and "refresh_claim_id" is null and "refresh_claimed_at" is null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_integrations`(`id`, `name`, `type`, `config`, `is_managed`, `refresh_state`, `config_revision`, `refresh_claim_id`, `refresh_claimed_at`, `created_at`, `updated_at`) SELECT `id`, `name`, `type`, `config`, `is_managed`, `refresh_state`, `config_revision`, `refresh_claim_id`, `refresh_claimed_at`, `created_at`, `updated_at` FROM `integrations`;--> statement-breakpoint
DROP TABLE `integrations`;--> statement-breakpoint
ALTER TABLE `__new_integrations` RENAME TO `integrations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_authorization_attempts` (
	`state_hash` text PRIMARY KEY,
	`integration_id` text,
	`expires_at` integer NOT NULL,
	`browser_binding_hash` text NOT NULL,
	`encrypted_payload` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`result_integration_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_oauth_authorization_attempts_integration_id_integrations_id_fk` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "oauth_authorization_attempts_mode_check" CHECK("mode" in ('create', 'reconnect')),
	CONSTRAINT "oauth_authorization_attempts_status_check" CHECK("status" in ('pending', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "oauth_authorization_attempts_integration_check" CHECK(("mode" = 'create' and "integration_id" is null) or ("mode" = 'reconnect' and "integration_id" is not null)),
	CONSTRAINT "oauth_authorization_attempts_result_check" CHECK(("status" = 'succeeded') = ("result_integration_id" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_oauth_authorization_attempts`(`state_hash`, `integration_id`, `expires_at`, `browser_binding_hash`, `encrypted_payload`, `mode`, `status`, `result_integration_id`, `created_at`, `updated_at`) SELECT `state_hash`, `integration_id`, `expires_at`, `browser_binding_hash`, `encrypted_payload`, `mode`, `status`, `result_integration_id`, `created_at`, `updated_at` FROM `oauth_authorization_attempts`;--> statement-breakpoint
DROP TABLE `oauth_authorization_attempts`;--> statement-breakpoint
ALTER TABLE `__new_oauth_authorization_attempts` RENAME TO `oauth_authorization_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
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
	CONSTRAINT "workflow_execution_schedule_subject_check" CHECK(("kind" = 'run' and "execution_id" is not null and "inbox_id" is null and "workflow_id" is null and "cron" is null and "time_zone" is null) or ("kind" = 'delivery' and "inbox_id" is not null and "execution_id" is null and "workflow_id" is null and "cron" is null and "time_zone" is null) or ("kind" = 'cron' and "workflow_id" is not null and "cron" is not null and "time_zone" is not null and "execution_id" is null and "inbox_id" is null)),
	CONSTRAINT "workflow_execution_schedule_lease_check" CHECK(("state" = 'leased' and "owner_token" is not null and "lease_expires_at" is not null and "worker_id" is not null) or ("state" <> 'leased' and "owner_token" is null and "lease_expires_at" is null and "worker_id" is null and "running_step_id" is null and "running_node_id" is null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_execution_schedule`(`id`, `kind`, `execution_id`, `inbox_id`, `workflow_id`, `cron`, `time_zone`, `state`, `wake_at`, `attempt`, `running_step_id`, `running_node_id`, `lease_expires_at`, `owner_token`, `worker_id`, `last_error`) SELECT `id`, `kind`, `execution_id`, `inbox_id`, `workflow_id`, `cron`, `time_zone`, `state`, `wake_at`, `attempt`, `running_step_id`, `running_node_id`, `lease_expires_at`, `owner_token`, `worker_id`, `last_error` FROM `workflow_execution_schedule`;--> statement-breakpoint
DROP TABLE `workflow_execution_schedule`;--> statement-breakpoint
ALTER TABLE `__new_workflow_execution_schedule` RENAME TO `workflow_execution_schedule`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_execution_steps` (
	`schedule_id` text NOT NULL,
	`step_id` text NOT NULL,
	`node_id` text,
	`status` text NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`value` text,
	`error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `workflow_execution_steps_pk` PRIMARY KEY(`schedule_id`, `step_id`),
	CONSTRAINT `fk_workflow_execution_steps_schedule_id_workflow_execution_schedule_id_fk` FOREIGN KEY (`schedule_id`) REFERENCES `workflow_execution_schedule`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_steps_status_check" CHECK("status" in ('succeeded', 'failing', 'failed')),
	CONSTRAINT "workflow_execution_steps_error_check" CHECK(("status" = 'succeeded') = ("error" is null)),
	CONSTRAINT "workflow_execution_steps_value_json_check" CHECK("value" is null or json_valid("value")),
	CONSTRAINT "workflow_execution_steps_value_check" CHECK("status" = 'succeeded' or "value" is null),
	CONSTRAINT "workflow_execution_steps_failures_check" CHECK("failures" >= 0 and ("status" = 'succeeded' or "failures" > 0))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_execution_steps`(`schedule_id`, `step_id`, `node_id`, `status`, `failures`, `value`, `error`, `created_at`) SELECT `schedule_id`, `step_id`, `node_id`, `status`, `failures`, `value`, `error`, `created_at` FROM `workflow_execution_steps`;--> statement-breakpoint
DROP TABLE `workflow_execution_steps`;--> statement-breakpoint
ALTER TABLE `__new_workflow_execution_steps` RENAME TO `workflow_execution_steps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_wait_states` (
	`id` text PRIMARY KEY,
	`execution_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`node_id` text NOT NULL,
	`node_name` text NOT NULL,
	`wait_type` text NOT NULL,
	`status` text NOT NULL,
	`resume_token` text UNIQUE,
	`wait_until` integer,
	`subscribed_events` text DEFAULT '[]' NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`resumed_at` integer,
	`cancelled_at` integer,
	`park_step_id` text,
	`wake` text,
	CONSTRAINT `fk_workflow_wait_states_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_wait_states_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_wait_states_wait_type_check" CHECK("wait_type" in ('delay', 'event')),
	CONSTRAINT "workflow_wait_states_status_check" CHECK("status" in ('waiting', 'resuming', 'resumed', 'timed_out', 'cancelled')),
	CONSTRAINT "workflow_wait_states_subscribed_events_json_check" CHECK(json_valid("subscribed_events") and json_type("subscribed_events") = 'array'),
	CONSTRAINT "workflow_wait_states_metadata_json_check" CHECK("metadata" is null or (json_valid("metadata") and json_type("metadata") = 'object')),
	CONSTRAINT "workflow_wait_states_wake_json_check" CHECK("wake" is null or json_valid("wake")),
	CONSTRAINT "workflow_wait_states_wake_check" CHECK(("status" <> 'waiting' or "wake" is null) and ("status" <> 'resuming' or "wake" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_wait_states`(`id`, `execution_id`, `workflow_id`, `node_id`, `node_name`, `wait_type`, `status`, `resume_token`, `wait_until`, `subscribed_events`, `metadata`, `created_at`, `resumed_at`, `cancelled_at`, `park_step_id`, `wake`) SELECT `id`, `execution_id`, `workflow_id`, `node_id`, `node_name`, `wait_type`, `status`, `resume_token`, `wait_until`, `subscribed_events`, `metadata`, `created_at`, `resumed_at`, `cancelled_at`, `park_step_id`, `wake` FROM `workflow_wait_states`;--> statement-breakpoint
DROP TABLE `workflow_wait_states`;--> statement-breakpoint
ALTER TABLE `__new_workflow_wait_states` RENAME TO `workflow_wait_states`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflows` (
	`id` text PRIMARY KEY,
	`name` text COLLATE NOCASE NOT NULL UNIQUE,
	`description` text,
	`graph` text NOT NULL,
	`draft_revision` integer DEFAULT 1 NOT NULL,
	`is_paused` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'live' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`published_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_workflows_published_version_id_workflow_versions_id_fk` FOREIGN KEY (`published_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "workflows_is_paused_check" CHECK("is_paused" in (0, 1)),
	CONSTRAINT "workflows_mode_check" CHECK("mode" in ('live', 'test')),
	CONSTRAINT "workflows_visibility_check" CHECK("visibility" in ('private', 'public'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflows`(`id`, `name`, `description`, `graph`, `draft_revision`, `is_paused`, `mode`, `visibility`, `published_version_id`, `created_at`, `updated_at`) SELECT `id`, `name`, `description`, `graph`, `draft_revision`, `is_paused`, `mode`, `visibility`, `published_version_id`, `created_at`, `updated_at` FROM `workflows`;--> statement-breakpoint
DROP TABLE `workflows`;--> statement-breakpoint
ALTER TABLE `__new_workflows` RENAME TO `workflows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_executions` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`workflow_version_id` text NOT NULL,
	`status` text NOT NULL,
	`start_source` text NOT NULL,
	`delivery_id` text,
	`run_mode` text DEFAULT 'live' NOT NULL,
	`start_event_name` text,
	`entity_value` text,
	`entity_type` text,
	`entity_id` text,
	`input` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`scheduled_for` integer,
	`schedule_cron` text,
	`schedule_time_zone` text,
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
	`cancel_delivery_id` text,
	CONSTRAINT `fk_workflow_executions_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_executions_workflow_version_id_workflow_versions_id_fk` FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_executions_status_check" CHECK("status" in ('running', 'waiting', 'completed', 'canceled', 'exited', 'superseded', 'failed')),
	CONSTRAINT "workflow_executions_entity_identity_pair_check" CHECK(("entity_type" is null and "entity_id" is null) or ("entity_type" is not null and "entity_id" is not null)),
	CONSTRAINT "workflow_executions_schedule_check" CHECK(("scheduled_for" is null and "schedule_cron" is null and "schedule_time_zone" is null) or ("scheduled_for" is not null and "schedule_cron" is not null and "schedule_time_zone" is not null and "start_source" = 'schedule')),
	CONSTRAINT "workflow_executions_termination_check" CHECK(("termination_kind" is null and "termination_requested_at" is null and "termination_reason" is null and "termination_node_id" is null) or ("termination_kind" = 'cancel' and "termination_requested_at" is not null and "termination_reason" is null and "termination_node_id" is null) or ("termination_kind" = 'exit' and "termination_requested_at" is not null and "termination_reason" in ('entity_condition_not_met', 'entity_not_found') and "termination_node_id" is not null)),
	CONSTRAINT "workflow_executions_start_source_check" CHECK("start_source" in ('event', 'schedule', 'manual')),
	CONSTRAINT "workflow_executions_run_mode_check" CHECK("run_mode" in ('live', 'test')),
	CONSTRAINT "workflow_executions_input_json_check" CHECK("input" is null or json_valid("input")),
	CONSTRAINT "workflow_executions_output_json_check" CHECK("output" is null or json_valid("output")),
	CONSTRAINT "workflow_executions_cancel_payload_json_check" CHECK("cancel_payload" is null or json_valid("cancel_payload"))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_executions`(`id`, `workflow_id`, `workflow_version_id`, `status`, `start_source`, `delivery_id`, `run_mode`, `start_event_name`, `entity_value`, `entity_type`, `entity_id`, `input`, `output`, `error`, `started_at`, `scheduled_for`, `schedule_cron`, `schedule_time_zone`, `waiting_at`, `cancelled_at`, `completed_at`, `duration`, `termination_kind`, `termination_requested_at`, `termination_reason`, `termination_node_id`, `cancel_event_name`, `cancel_payload`, `cancel_delivery_id`) SELECT `id`, `workflow_id`, `workflow_version_id`, `status`, `start_source`, `delivery_id`, `run_mode`, `start_event_name`, `entity_value`, `entity_type`, `entity_id`, `input`, `output`, `error`, `started_at`, `scheduled_for`, `schedule_cron`, `schedule_time_zone`, `waiting_at`, `cancelled_at`, `completed_at`, `duration`, `termination_kind`, `termination_requested_at`, `termination_reason`, `termination_node_id`, `cancel_event_name`, `cancel_payload`, `cancel_delivery_id` FROM `workflow_executions`;--> statement-breakpoint
DROP TABLE `workflow_executions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_executions` RENAME TO `workflow_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `integrations_type_idx` ON `integrations` (`type`);--> statement-breakpoint
CREATE INDEX `oauth_attempts_integration_idx` ON `oauth_authorization_attempts` (`integration_id`);--> statement-breakpoint
CREATE INDEX `oauth_attempts_expires_at_idx` ON `oauth_authorization_attempts` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_execution_uidx` ON `workflow_execution_schedule` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_inbox_uidx` ON `workflow_execution_schedule` (`inbox_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_cron_uidx` ON `workflow_execution_schedule` (`workflow_id`,`cron`,`time_zone`);--> statement-breakpoint
CREATE INDEX `schedule_due_idx` ON `workflow_execution_schedule` (`wake_at`,`id`) WHERE "workflow_execution_schedule"."state" in ('queued', 'waiting');--> statement-breakpoint
CREATE INDEX `schedule_lease_idx` ON `workflow_execution_schedule` (`lease_expires_at`) WHERE "workflow_execution_schedule"."state" = 'leased';--> statement-breakpoint
CREATE INDEX `waits_execution_status_idx` ON `workflow_wait_states` (`execution_id`,`status`);--> statement-breakpoint
CREATE INDEX `waits_workflow_status_idx` ON `workflow_wait_states` (`workflow_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `waits_execution_node_uidx` ON `workflow_wait_states` (`execution_id`,`node_id`);--> statement-breakpoint
CREATE INDEX `workflows_published_version_idx` ON `workflows` (`published_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_executions_workflow_id_delivery_id_uidx` ON `workflow_executions` (`workflow_id`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `executions_workflow_started_idx` ON `workflow_executions` (`workflow_id`,`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_started_idx` ON `workflow_executions` (`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_value`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_typed_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_type`,`entity_id`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_workflow_in_flight_version_started_idx` ON `workflow_executions` (`workflow_id`,`workflow_version_id`,`started_at`) WHERE "workflow_executions"."status" in ('running', 'waiting');--> statement-breakpoint
CREATE INDEX `executions_workflow_version_idx` ON `workflow_executions` (`workflow_version_id`);--> statement-breakpoint
CREATE INDEX `executions_completed_idx` ON `workflow_executions` (`completed_at`) WHERE "workflow_executions"."completed_at" is not null;