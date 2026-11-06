CREATE TABLE `workflow_cancel_decisions` (
	`delivery_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`decided_at` integer NOT NULL,
	CONSTRAINT `workflow_cancel_decisions_pk` PRIMARY KEY(`delivery_id`, `workflow_id`),
	CONSTRAINT `fk_workflow_cancel_decisions_delivery_id_workflow_event_inbox_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `workflow_event_inbox`(`id`) ON DELETE CASCADE
) STRICT;
