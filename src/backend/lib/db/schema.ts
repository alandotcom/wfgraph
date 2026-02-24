import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IntegrationType } from "@/shared/types/integration";
import { generateId } from "@/shared/utils/id";
import type { SerializedWorkflowGraph } from "@/shared/workflow/types";

// Workflow visibility type
export type WorkflowVisibility = "private" | "public";
export type WorkflowMode = "live" | "test";

export const workflows = pgTable(
  "workflows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    graph: jsonb("graph").notNull().$type<SerializedWorkflowGraph>(),
    isPaused: boolean("is_paused").notNull().default(false),
    mode: text("mode").notNull().default("live").$type<WorkflowMode>(),
    visibility: text("visibility")
      .notNull()
      .default("private")
      .$type<WorkflowVisibility>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workflows_name_ci_uidx").on(sql`lower(${table.name})`),
  ]
);

export const integrations = pgTable("integrations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => generateId()),
  name: text("name").notNull(),
  type: text("type").notNull().$type<IntegrationType>(),
  // biome-ignore lint/suspicious/noExplicitAny: JSONB type - encrypted credentials stored as JSON
  config: jsonb("config").notNull().$type<any>(),
  isManaged: boolean("is_managed").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const workflowExecutions = pgTable(
  "workflow_executions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workflowRunId: text("workflow_run_id"),
    status: text("status")
      .notNull()
      .$type<
        "pending" | "running" | "waiting" | "success" | "error" | "cancelled"
      >(),
    triggerType: text("trigger_type").$type<"manual" | "webhook" | "event">(),
    runMode: text("run_mode").notNull().default("live").$type<WorkflowMode>(),
    triggerEventType: text("trigger_event_type"),
    correlationKey: text("correlation_key"),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    input: jsonb("input").$type<Record<string, any>>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    output: jsonb("output").$type<any>(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    waitingAt: timestamp("waiting_at"),
    cancelledAt: timestamp("cancelled_at"),
    completedAt: timestamp("completed_at"),
    duration: text("duration"),
  },
  (table) => [
    uniqueIndex("workflow_executions_workflow_run_id_uidx").on(
      table.workflowRunId
    ),
    index("workflow_executions_workflow_id_started_at_idx").on(
      table.workflowId,
      table.startedAt
    ),
    index("workflow_executions_workflow_id_correlation_key_idx").on(
      table.workflowId,
      table.correlationKey
    ),
  ]
);

export const workflowExecutionLogs = pgTable(
  "workflow_execution_logs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status")
      .notNull()
      .$type<"pending" | "running" | "success" | "error">(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    input: jsonb("input").$type<any>(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    output: jsonb("output").$type<any>(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    duration: text("duration"),
    timestamp: timestamp("timestamp").notNull().defaultNow(),
  },
  (table) => [
    index("workflow_execution_logs_execution_id_idx").on(table.executionId),
    index("workflow_execution_logs_execution_id_timestamp_idx").on(
      table.executionId,
      table.timestamp
    ),
  ]
);

export const workflowWaitStates = pgTable(
  "workflow_wait_states",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    waitType: text("wait_type").notNull().$type<"delay" | "hook">(),
    status: text("status")
      .notNull()
      .$type<"waiting" | "resumed" | "timed_out" | "cancelled">(),
    hookToken: text("hook_token"),
    waitUntil: timestamp("wait_until"),
    correlationKey: text("correlation_key"),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    metadata: jsonb("metadata").$type<Record<string, any>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resumedAt: timestamp("resumed_at"),
    cancelledAt: timestamp("cancelled_at"),
  },
  (table) => [
    uniqueIndex("workflow_wait_states_hook_token_uidx").on(table.hookToken),
    index("workflow_wait_states_execution_status_idx").on(
      table.executionId,
      table.status
    ),
    index("workflow_wait_states_workflow_correlation_status_idx").on(
      table.workflowId,
      table.correlationKey,
      table.status
    ),
    index("workflow_wait_states_run_id_idx").on(table.runId),
  ]
);

export const workflowExecutionEvents = pgTable(
  "workflow_execution_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    executionId: text("execution_id").references(() => workflowExecutions.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    // biome-ignore lint/suspicious/noExplicitAny: JSONB type - structure validated at application level
    metadata: jsonb("metadata").$type<Record<string, any>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("workflow_execution_events_workflow_created_at_idx").on(
      table.workflowId,
      table.createdAt
    ),
    index("workflow_execution_events_execution_created_at_idx").on(
      table.executionId,
      table.createdAt
    ),
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name"),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [index("api_keys_key_prefix_idx").on(table.keyPrefix)]
);

export const workflowExecutionsRelations = relations(
  workflowExecutions,
  ({ one }) => ({
    workflow: one(workflows, {
      fields: [workflowExecutions.workflowId],
      references: [workflows.id],
    }),
  })
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
export type NewWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type WorkflowExecutionLog = typeof workflowExecutionLogs.$inferSelect;
export type NewWorkflowExecutionLog = typeof workflowExecutionLogs.$inferInsert;
export type WorkflowWaitState = typeof workflowWaitStates.$inferSelect;
export type NewWorkflowWaitState = typeof workflowWaitStates.$inferInsert;
export type WorkflowExecutionEvent =
  typeof workflowExecutionEvents.$inferSelect;
export type NewWorkflowExecutionEvent =
  typeof workflowExecutionEvents.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
