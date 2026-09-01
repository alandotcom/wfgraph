-- Drizzle Kit cannot yet express SQLite STRICT tables, WITHOUT ROWID, or
-- descending index columns. Those clauses preserve the existing v7 schema.
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`name` text,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
) STRICT;
--> statement-breakpoint
CREATE TABLE `integrations` (
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
	CONSTRAINT "integrations_refresh_state_check" CHECK("refresh_state" in ('idle', 'refreshing', 'reauthorization_required'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `oauth_authorization_attempts` (
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
	CONSTRAINT "oauth_authorization_attempts_status_check" CHECK("status" in ('pending', 'processing', 'succeeded', 'failed'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflow_event_subscriptions` (
	`workflow_id` text NOT NULL,
	`event_name` text NOT NULL,
	`role` text NOT NULL,
	`correlation_path` text,
	`connection_id` text,
	CONSTRAINT `workflow_event_subscriptions_pk` PRIMARY KEY(`workflow_id`, `event_name`, `role`),
	CONSTRAINT `fk_workflow_event_subscriptions_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_event_subscriptions_role_check" CHECK("role" in ('start', 'cancel', 'wait'))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `workflow_execution_events` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`execution_id` text,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_workflow_execution_events_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_execution_events_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_events_metadata_json_check" CHECK("metadata" is null or (json_valid("metadata") and json_type("metadata") = 'object'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflow_execution_logs` (
	`id` text PRIMARY KEY,
	`execution_id` text NOT NULL,
	`node_id` text NOT NULL,
	`node_name` text NOT NULL,
	`node_type` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration` text,
	`timestamp` integer NOT NULL,
	CONSTRAINT `fk_workflow_execution_logs_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_execution_logs_status_check" CHECK("status" in ('pending', 'running', 'success', 'error', 'cancelled')),
	CONSTRAINT "workflow_execution_logs_input_json_check" CHECK("input" is null or json_valid("input")),
	CONSTRAINT "workflow_execution_logs_output_json_check" CHECK("output" is null or json_valid("output"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`workflow_version_id` text NOT NULL,
	`workflow_run_id` text UNIQUE,
	`status` text NOT NULL,
	`start_source` text,
	`delivery_id` text,
	`enqueued_at` integer,
	`run_mode` text DEFAULT 'live' NOT NULL,
	`start_event_name` text,
	`entity_value` text,
	`input` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`waiting_at` integer,
	`cancelled_at` integer,
	`completed_at` integer,
	`duration` text,
	`cancel_requested_at` integer,
	`cancel_event_name` text,
	`cancel_payload` text,
	CONSTRAINT `fk_workflow_executions_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_executions_workflow_version_id_workflow_versions_id_fk` FOREIGN KEY (`workflow_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_executions_status_check" CHECK("status" in ('pending', 'running', 'waiting', 'completed', 'failed', 'canceled', 'superseded')),
	CONSTRAINT "workflow_executions_start_source_check" CHECK("start_source" is null or "start_source" in ('event', 'manual', 'schedule')),
	CONSTRAINT "workflow_executions_run_mode_check" CHECK("run_mode" in ('live', 'test')),
	CONSTRAINT "workflow_executions_input_json_check" CHECK("input" is null or json_valid("input")),
	CONSTRAINT "workflow_executions_output_json_check" CHECK("output" is null or json_valid("output")),
	CONSTRAINT "workflow_executions_cancel_payload_json_check" CHECK("cancel_payload" is null or json_valid("cancel_payload"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`version` integer,
	`kind` text DEFAULT 'published' NOT NULL,
	`graph` text NOT NULL,
	`catalog_fingerprint` text NOT NULL,
	`graph_digest` text NOT NULL,
	`published_at` integer NOT NULL,
	CONSTRAINT `fk_workflow_versions_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_versions_kind_check" CHECK("kind" in ('published', 'draft_snapshot'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflow_wait_states` (
	`id` text PRIMARY KEY,
	`execution_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`run_id` text NOT NULL,
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
	CONSTRAINT `fk_workflow_wait_states_execution_id_workflow_executions_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workflow_wait_states_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_wait_states_wait_type_check" CHECK("wait_type" in ('delay', 'event')),
	CONSTRAINT "workflow_wait_states_status_check" CHECK("status" in ('waiting', 'resuming', 'resumed', 'timed_out', 'cancelled')),
	CONSTRAINT "workflow_wait_states_subscribed_events_json_check" CHECK(json_valid("subscribed_events") and json_type("subscribed_events") = 'array'),
	CONSTRAINT "workflow_wait_states_metadata_json_check" CHECK("metadata" is null or (json_valid("metadata") and json_type("metadata") = 'object'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY,
	`name` text COLLATE NOCASE NOT NULL UNIQUE,
	`description` text,
	`graph` text NOT NULL,
	`is_paused` integer DEFAULT 0 NOT NULL,
	`mode` text DEFAULT 'live' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`published_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_workflows_published_version_id_workflow_versions_id_fk` FOREIGN KEY (`published_version_id`) REFERENCES `workflow_versions`(`id`) ON DELETE SET NULL,
	CONSTRAINT "workflows_is_paused_check" CHECK("is_paused" in (0, 1)),
	CONSTRAINT "workflows_mode_check" CHECK("mode" in ('live', 'test')),
	CONSTRAINT "workflows_visibility_check" CHECK("visibility" in ('private', 'public'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `api_keys_prefix_idx` ON `api_keys` (`key_prefix`);--> statement-breakpoint
CREATE INDEX `integrations_type_idx` ON `integrations` (`type`);--> statement-breakpoint
CREATE INDEX `oauth_attempts_integration_idx` ON `oauth_authorization_attempts` (`integration_id`);--> statement-breakpoint
CREATE INDEX `oauth_attempts_expires_at_idx` ON `oauth_authorization_attempts` (`expires_at`);--> statement-breakpoint
CREATE INDEX `subscriptions_event_idx` ON `workflow_event_subscriptions` (`event_name`);--> statement-breakpoint
CREATE INDEX `events_execution_created_idx` ON `workflow_execution_events` (`execution_id`,`created_at` DESC);--> statement-breakpoint
CREATE INDEX `events_workflow_created_idx` ON `workflow_execution_events` (`workflow_id`,`created_at` DESC);--> statement-breakpoint
CREATE INDEX `logs_execution_timestamp_idx` ON `workflow_execution_logs` (`execution_id`,`timestamp` DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_executions_workflow_id_delivery_id_uidx` ON `workflow_executions` (`workflow_id`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `executions_workflow_started_idx` ON `workflow_executions` (`workflow_id`,`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_started_idx` ON `workflow_executions` (`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_value`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_workflow_in_flight_version_started_idx` ON `workflow_executions` (`workflow_id`,`workflow_version_id`,`started_at`) WHERE "workflow_executions"."status" in ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_workflow_id_version_uidx` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE INDEX `waits_execution_status_idx` ON `workflow_wait_states` (`execution_id`,`status`);--> statement-breakpoint
CREATE INDEX `waits_workflow_status_idx` ON `workflow_wait_states` (`workflow_id`,`status`);
