-- Preserve legacy durable Cancel claims before the old timestamp column is removed.
UPDATE `workflow_executions`
SET `termination_kind` = 'cancel',
    `termination_requested_at` = `cancel_requested_at`
WHERE `cancel_requested_at` IS NOT NULL;
