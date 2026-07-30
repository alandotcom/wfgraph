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
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "#src/backend/lib/workflow-audit";
import type { JsonObject } from "@rova/shared/types/json";
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
  type: text("type").notNull(),
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

/** The workflow-scoped audit types as SQL literals, quoted for the same reason. */
const workflowScopedTypeLiterals = WORKFLOW_SCOPED_AUDIT_EVENT_TYPES.map(
  (eventType) => `'${eventType}'`
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
    // The arrival this run answers, which is what makes opening it idempotent:
    // the lifecycle step is an Inngest step and a retry re-runs it, so a second
    // attempt re-claims this row instead of opening a second run for one Event.
    // Null for a manual or scheduled start, which no retry loop replays.
    deliveryId: text("delivery_id"),
    // When the bus was told about this run. Null means the row was opened and
    // the send has not been confirmed, which is the one window a crash can leave
    // an in-flight row behind that nothing will ever finish.
    enqueuedAt: timestamp("enqueued_at"),
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
    // The Canceled outlet's authority (ADR-0007). A Cancel Event stamps these
    // three and the run reads them at its next node boundary, inside a step, so
    // the answer is memoized and a replay takes the same branch. Nothing kills
    // the run: it routes to the `canceled` outlet carrying this payload.
    cancelRequestedAt: timestamp("cancel_requested_at"),
    cancelEventName: text("cancel_event_name"),
    cancelPayload: jsonb("cancel_payload").$type<JsonObject>(),
  },
  (table) => [
    uniqueIndex("workflow_executions_workflow_run_id_uidx").on(
      table.workflowRunId
    ),
    // One run per arrival per workflow. Postgres treats nulls as distinct in a
    // unique index, so the manual and scheduled starts that carry no delivery id
    // are unconstrained by it.
    uniqueIndex("workflow_executions_workflow_id_delivery_id_uidx").on(
      table.workflowId,
      table.deliveryId
    ),
    // The per-workflow run list, with `id` carrying the cursor's tiebreak so a
    // page after the first rides the index rather than filtering.
    index("workflow_executions_workflow_id_started_at_idx").on(
      table.workflowId,
      table.startedAt,
      table.id
    ),
    // The dashboard's cross-workflow page, which filters on nothing and sorts on
    // this pair. A backward scan serves the `desc, desc` order, so the columns
    // are declared plain.
    index("workflow_executions_started_at_id_idx").on(
      table.startedAt,
      table.id
    ),
    // The Refused Starts toggle's count, on the runs panel's two-second poll.
    // Partial because superseded is the status that accretes without bound, and
    // counting it off the (workflow_id, started_at) index meant walking every
    // run the workflow ever produced.
    index("workflow_executions_superseded_by_workflow_idx")
      .on(table.workflowId)
      .where(sql`${table.status} = 'superseded'`),
    // The same poll's default run list, which hides superseded rows. Without
    // this, a newest-wins workflow walks a long discarded prefix to fill 50.
    index("workflow_executions_live_by_workflow_idx")
      .on(table.workflowId, table.startedAt)
      .where(sql`${table.status} <> 'superseded'`),
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
    waitType: text("wait_type").notNull().$type<"delay" | "event">(),
    status: text("status")
      .notNull()
      .$type<"waiting" | "resumed" | "timed_out" | "cancelled">(),
    /**
     * What `POST /workflows/waits/:token/resume` unparks this run by. Generated
     * per park: a token decided at design time is one two runs at the same node
     * would collide on, and a unique index leaves one of them unfindable.
     */
    resumeToken: text("resume_token"),
    waitUntil: timestamp("wait_until"),
    /**
     * The Events this run parked on, as the node named them at park time. A
     * delivery finds parked runs through this rather than through the graph,
     * which is what keeps a run reachable after an edit to the node it parked
     * on. Which of those runs an arrival actually wakes is then decided by the
     * compiled match in `metadata.waitFor`.
     */
    subscribedEvents: text("subscribed_events").array(),
    metadata: jsonb("metadata").$type<Record<string, any>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resumedAt: timestamp("resumed_at"),
    cancelledAt: timestamp("cancelled_at"),
  },
  (table) => [
    uniqueIndex("workflow_wait_states_resume_token_uidx").on(table.resumeToken),
    index("workflow_wait_states_execution_status_idx").on(
      table.executionId,
      table.status
    ),
    // The delivery fan-out's parked-run question, asked of every arrival: which
    // runs are still waiting on this Event name. GIN because the answer is a
    // containment test over the array, partial because a resumed or timed-out row
    // can never be one.
    index("workflow_wait_states_subscribed_events_idx")
      .using("gin", table.subscribedEvents)
      .where(sql`${table.status} = 'waiting'`),
    // The other half of that question. GIN has no leading column, so the
    // containment test alone returns every waiting row subscribed to the Event
    // across every workflow; Postgres BitmapAnds this with it and rechecks only
    // the asking workflow's parked rows.
    index("workflow_wait_states_waiting_by_workflow_idx")
      .on(table.workflowId)
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
    // The Refused Starts list on the runs panel's two-second poll. Its LIMIT is
    // 50 and a healthy workflow has fewer refusals than that, so the scan never
    // stops early and walked the workflow's whole audit history without this.
    // The predicate is built from the same list the query's filter is, so the
    // two cannot drift.
    index("workflow_execution_events_workflow_scoped_idx")
      .on(table.workflowId, table.createdAt)
      .where(
        sql`${table.eventType} in (${sql.raw(workflowScopedTypeLiterals)})`
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
