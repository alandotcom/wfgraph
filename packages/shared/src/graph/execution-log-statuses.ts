/**
 * Every status one node's execution log can hold. This file imports nothing,
 * so the Drizzle schema can name the literals without `#src/`.
 */
export const EXECUTION_LOG_STATUSES = [
  "pending",
  "running",
  "success",
  "error",
  "cancelled",
] as const;

export type ExecutionLogStatus = (typeof EXECUTION_LOG_STATUSES)[number];
