import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IntegrationType } from "@rova/shared/types/integration";
import { generateId } from "@rova/shared/utils/id";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@rova/shared/workflow/execution-contracts";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

// Every table here is unqualified, and the Postgres schema holding them is the
// host's `database.schema` option: the connection's search_path names it, on the
// query client and on the migration client alike. Naming it here instead, with
// `pgSchema`, would bake one schema into the generated migration SQL and into
// every query, which is what made the name unconfigurable.

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
  config: jsonb("config").notNull().$type<any>(),
  isManaged: boolean("is_managed").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * The in-flight statuses as SQL literals, for the partial index below.
 *
 * They are quoted by hand because `sql.raw` interpolates them as written. That is
 * safe by construction rather than by escaping: the list is a closed union of
 * lower-case words declared in `execution-contracts.ts`, so nothing here can
 * carry a quote.
 */
const inFlightStatusLiterals = IN_FLIGHT_EXECUTION_STATUSES.map(
  (status) => `'${status}'`
).join(", ");

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
    status: text("status").notNull().$type<WorkflowExecutionStatus>(),
    startSource: text("start_source").$type<WorkflowExecutionStartSource>(),
    runMode: text("run_mode").notNull().default("live").$type<WorkflowMode>(),
    triggerEventType: text("trigger_event_type"),
    correlationKey: text("correlation_key"),
    input: jsonb("input").$type<Record<string, any>>(),
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
    // Partial index for Concurrency's candidate query: the live set per entity
    // stays tiny while terminal rows accrete without bound, so the index tracks
    // only the rows the query can return. The predicate is built from the same
    // list the query's guard is, so the two cannot drift.
    index("workflow_executions_in_flight_by_correlation_idx")
      .on(table.workflowId, table.correlationKey, table.runMode)
      .where(sql`${table.status} in (${sql.raw(inFlightStatusLiterals)})`),
  ]
);

/**
 * Which workflows care about which Events, derived from their graphs.
 *
 * The listener set is app-wide, so a delivered Event needs one indexed lookup to
 * find the workflows it concerns rather than a scan of every stored graph. The
 * rows are rewritten in the same transaction as the graph they come from, and
 * the fan-out re-reads a workflow's rules before acting, so a row that somehow
 * outlived its graph costs a wasted read and nothing else.
 */
export const workflowEventSubscriptions = pgTable(
  "workflow_event_subscriptions",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    eventName: text("event_name").notNull(),
    role: text("role").notNull().$type<"start" | "cancel" | "wait">(),
    /**
     * Where this workflow reads the Event's Entity Value, for an Event whose
     * definition declares no Correlation Path. It is derived from the same rules
     * the row is, so a delivery resolves the path from this index instead of
     * reading the graph column the rules sit in.
     */
    correlationPath: text("correlation_path"),
  },
  (table) => [
    primaryKey({
      columns: [table.workflowId, table.eventName, table.role],
    }),
    index("workflow_event_subscriptions_event_name_idx").on(table.eventName),
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
    input: jsonb("input").$type<any>(),
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
    /**
     * The Events this run parked on, as the node named them at park time. A
     * delivery finds parked runs through this rather than through the graph,
     * which is what keeps a run reachable after an edit to the node it parked
     * on. B6 grows this into a stored predicate over the payload.
     */
    subscribedEvents: text("subscribed_events").array(),
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
    // The delivery fan-out's parked-run question, asked of every arrival: which
    // runs are still waiting on this Event name. GIN because the answer is a
    // containment test over the array, partial because a resumed or timed-out row
    // can never be one.
    index("workflow_wait_states_subscribed_events_idx")
      .using("gin", table.subscribedEvents)
      .where(sql`${table.status} = 'waiting'`),
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
export type NewIntegration = typeof integrations.$inferInsert;
