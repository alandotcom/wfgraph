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
	CONSTRAINT "workflow_versions_last_pinned_kind_check" CHECK(("kind" = 'draft_snapshot') = ("last_pinned_at" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_workflow_versions`(`id`, `workflow_id`, `version`, `kind`, `graph`, `catalog_fingerprint`, `graph_digest`, `published_at`, `last_pinned_at`) SELECT `id`, `workflow_id`, `version`, `kind`, `graph`, `catalog_fingerprint`, `graph_digest`, `published_at`, `last_pinned_at` FROM `workflow_versions`;--> statement-breakpoint
DROP TABLE `workflow_versions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_versions` RENAME TO `workflow_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_workflow_id_version_uidx` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE INDEX `versions_draft_snapshot_last_pinned_idx` ON `workflow_versions` (`last_pinned_at`) WHERE "workflow_versions"."kind" = 'draft_snapshot';