-- Drizzle Kit cannot yet express SQLite STRICT tables or descending index
-- columns. The rebuilds below keep both as the tables had them.
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
	CONSTRAINT "workflow_executions_completed_check" CHECK(("status" in ('completed', 'canceled', 'exited', 'superseded', 'failed')) = ("completed_at" is not null)),
	CONSTRAINT "workflow_executions_waiting_check" CHECK(("status" = 'waiting') = ("waiting_at" is not null)),
	CONSTRAINT "workflow_executions_cancelled_check" CHECK(("status" = 'canceled') = ("cancelled_at" is not null)),
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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_versions` (
	`id` text PRIMARY KEY,
	`workflow_id` text NOT NULL,
	`version` integer,
	`kind` text DEFAULT 'published' NOT NULL,
	`graph` text NOT NULL,
	`catalog_fingerprint` text NOT NULL,
	`graph_digest` text NOT NULL,
	`published_at` integer NOT NULL,
	`last_pinned_at` integer,
	CONSTRAINT `fk_workflow_versions_workflow_id_workflows_id_fk` FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workflow_versions_kind_check" CHECK("kind" in ('published', 'draft_snapshot')),
	CONSTRAINT "workflow_versions_version_kind_check" CHECK(("kind" = 'published') = ("version" is not null)),
	CONSTRAINT "workflow_versions_last_pinned_kind_check" CHECK(("kind" = 'draft_snapshot') = ("last_pinned_at" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_versions`(`id`, `workflow_id`, `version`, `kind`, `graph`, `catalog_fingerprint`, `graph_digest`, `published_at`, `last_pinned_at`) SELECT `id`, `workflow_id`, `version`, `kind`, `graph`, `catalog_fingerprint`, `graph_digest`, `published_at`, `last_pinned_at` FROM `workflow_versions`;--> statement-breakpoint
DROP TABLE `workflow_versions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_versions` RENAME TO `workflow_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `waits_workflow_status_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_executions_workflow_id_delivery_id_uidx` ON `workflow_executions` (`workflow_id`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `executions_workflow_started_idx` ON `workflow_executions` (`workflow_id`,`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_started_idx` ON `workflow_executions` (`started_at` DESC,`id` DESC);--> statement-breakpoint
CREATE INDEX `executions_superseded_by_workflow_idx` ON `workflow_executions` (`workflow_id`) WHERE "workflow_executions"."status" = 'superseded';--> statement-breakpoint
CREATE INDEX `executions_live_by_workflow_idx` ON `workflow_executions` (`workflow_id`,`started_at`,`id`) WHERE "workflow_executions"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX `executions_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_value`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_typed_entity_idx` ON `workflow_executions` (`workflow_id`,`entity_type`,`entity_id`,`run_mode`,`status`);--> statement-breakpoint
CREATE INDEX `executions_workflow_in_flight_version_started_idx` ON `workflow_executions` (`workflow_id`,`workflow_version_id`,`started_at`) WHERE "workflow_executions"."status" in ('running', 'waiting');--> statement-breakpoint
CREATE INDEX `executions_workflow_version_idx` ON `workflow_executions` (`workflow_version_id`);--> statement-breakpoint
CREATE INDEX `executions_completed_idx` ON `workflow_executions` (`completed_at`) WHERE "workflow_executions"."completed_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_workflow_id_version_uidx` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE INDEX `versions_draft_snapshot_last_pinned_idx` ON `workflow_versions` (`last_pinned_at`) WHERE "workflow_versions"."kind" = 'draft_snapshot';--> statement-breakpoint
CREATE INDEX `versions_draft_snapshot_digest_idx` ON `workflow_versions` (`workflow_id`,`graph_digest`) WHERE "workflow_versions"."kind" = 'draft_snapshot';--> statement-breakpoint
CREATE INDEX `waits_workflow_status_id_idx` ON `workflow_wait_states` (`workflow_id`,`status`,`id`);