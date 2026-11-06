ALTER TABLE `workflow_execution_logs` ADD `retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_execution_schedule` ADD `running_node_id` text;--> statement-breakpoint
ALTER TABLE `workflow_execution_steps` ADD `node_id` text;