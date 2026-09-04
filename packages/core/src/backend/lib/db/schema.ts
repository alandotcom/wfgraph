import { defineRelations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";
import {
  INTEGRATION_REFRESH_STATES,
  type IntegrationRefreshState,
} from "@wfgraph/shared/types/integration";
import { generateId } from "@wfgraph/shared/utils/id";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";

// Every table here is unqualified, and the Postgres schema holding them is the
// host's `database.schema` option: the connection's search_path names it, on the
// query client and on the migration client alike. Naming it here instead, with
// `pgSchema`, would bake one schema into the generated migration SQL and into
// every query, which is what made the name unconfigurable.

/**
 * The default for a `timestamp` column, which is timezone-naive and read back as
 * UTC. Plain `now()` writes the session's own wall clock, so on a server whose
 * timezone is not UTC a defaulted row disagrees with every timestamp the app
 * writes from a `Date`.
 */
const utcNow = () => sql`(now() at time zone 'utc')`;

// Workflow visibility type
export type WorkflowVisibility = "private" | "public";
export type WorkflowMode = "live" | "test";
export type OAuthAuthorizationAttemptMode = "create" | "reconnect";
export type OAuthAuthorizationAttemptStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed";

// This is safe to interpolate with `sql.raw`: it comes from the closed
// lower-case union in shared, so a value cannot introduce SQL syntax.
const integrationRefreshStateLiterals = INTEGRATION_REFRESH_STATES.map(
  (state) => `'${state}'`
).join(", ");

/** The version kinds as SQL literals. Safe to interpolate for the same reason. */
const workflowVersionKindLiterals = WORKFLOW_VERSION_KINDS.map(
  (kind) => `'${kind}'`
).join(", ");

export const workflows = pgTable(
  "workflows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The editable draft. An Event start and a manual run of the published
     * version both load the published version instead. The one reader here is a
     * Draft run, which freezes this graph into a `draft_snapshot` version and
     * pins itself to that.
     */
    graph: jsonb("graph").notNull().$type<SerializedWorkflowGraph>(),
    draftRevision: integer("draft_revision").notNull().default(1),
    isPaused: boolean("is_paused").notNull().default(false),
    mode: text("mode").notNull().default("live").$type<WorkflowMode>(),
    visibility: text("visibility")
      .notNull()
      .default("private")
      .$type<WorkflowVisibility>(),
    /**
     * The version event and manual starts use. Null until the first publish, and
     * a start against a never-published workflow is refused. Lazy FK: the
     * versions table references this one the other way.
     */
    publishedVersionId: text("published_version_id").references(
      (): AnyPgColumn => workflowVersions.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at").notNull().default(utcNow()),
    updatedAt: timestamp("updated_at").notNull().default(utcNow()),
  },
  (table) => [
    uniqueIndex("workflows_name_ci_uidx").on(sql`lower(${table.name})`),
    // The version sweep at publish deletes workflow_versions rows, and this FK
    // is `on delete set null`, so Postgres runs that action on every one of
    // them. Unindexed, each delete scans the whole workflows table; the sweep's
    // own "is this version published" predicate reads the same index.
    index("workflows_published_version_id_idx").on(table.publishedVersionId),
  ]
);

/**
 * An immutable graph a run can pin to, plus the catalog fingerprint it was sound
 * against.
 *
 * Each Publish mints the next `published` row, and every Execution pins to one.
 * A Draft run mints a `draft_snapshot`, the same frozen graph with no version
 * number. Snapshots are skipped by the history, the latest-version read and the
 * Event subscription index, so only a manual start runs one. Saving a draft
 * writes nothing here.
 */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /**
     * Monotonic per workflow, starting at 1, on a published row. Null on a draft
     * snapshot. Nulls are distinct under the unique index below, so any number
     * of snapshots can sit beside the numbered history.
     */
    version: integer("version"),
    /** Which kind of row this is. See `WORKFLOW_VERSION_KINDS`. */
    kind: text("kind")
      .notNull()
      .default("published")
      .$type<WorkflowVersionKind>(),
    graph: jsonb("graph").notNull().$type<SerializedWorkflowGraph>(),
    /**
     * Hash of the assembled extension catalog at publish. A deploy that changes
     * the catalog surface fails a waking node rather than running against a
     * different set of actions; it does not freeze host handler code.
     */
    catalogFingerprint: text("catalog_fingerprint").notNull(),
    /** Content hash of the graph's semantic projection. */
    graphDigest: text("graph_digest").notNull(),
    /** When the row was created, by a Publish or by a Draft run. */
    publishedAt: timestamp("published_at").notNull().default(utcNow()),
  },
  (table) => [
    uniqueIndex("workflow_versions_workflow_id_version_uidx").on(
      table.workflowId,
      table.version
    ),
    check(
      "workflow_versions_kind_check",
      sql`${table.kind} in (${sql.raw(workflowVersionKindLiterals)})`
    ),
    // `kind` and `version` state the same fact twice, and readers depend on the
    // pairing: `asPublishedVersion` treats a numbered row as published history,
    // and `PublishedWorkflowVersion` types the number as present. This check
    // keeps a published row from arriving without a number, and keeps a snapshot
    // from arriving with one.
    check(
      "workflow_versions_version_kind_check",
      sql`(${table.kind} = 'published') = (${table.version} is not null)`
    ),
  ]
);

export const integrations = pgTable(
  "integrations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text("name").notNull(),
    type: text("type").notNull(),
    // The AES envelope `integrations/cipher.ts` seals the credentials into, which
    // is one string however many fields the connection form had.
    config: jsonb("config").notNull().$type<string>(),
    configRevision: integer("config_revision").notNull().default(0),
    isManaged: boolean("is_managed").default(false),
    refreshState: text("refresh_state")
      .notNull()
      .default(INTEGRATION_REFRESH_STATES[0])
      .$type<IntegrationRefreshState>(),
    refreshClaimId: text("refresh_claim_id"),
    refreshClaimedAt: timestamp("refresh_claimed_at"),
    createdAt: timestamp("created_at").notNull().default(utcNow()),
    updatedAt: timestamp("updated_at").notNull().default(utcNow()),
  },
  (table) => [
    check(
      "integrations_refresh_state_check",
      sql`${table.refreshState} in (${sql.raw(integrationRefreshStateLiterals)})`
    ),
  ]
);

export const oauthAuthorizationAttempts = pgTable(
  "oauth_authorization_attempts",
  {
    stateHash: text("state_hash").primaryKey(),
    integrationId: text("integration_id").references(() => integrations.id, {
      onDelete: "cascade",
    }),
    mode: text("mode")
      .notNull()
      .default("reconnect")
      .$type<OAuthAuthorizationAttemptMode>(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<OAuthAuthorizationAttemptStatus>(),
    expiresAt: timestamp("expires_at").notNull(),
    browserBindingHash: text("browser_binding_hash").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    resultIntegrationId: text("result_integration_id"),
    createdAt: timestamp("created_at").notNull().default(utcNow()),
    updatedAt: timestamp("updated_at").notNull().default(utcNow()),
  },
  (table) => [
    check(
      "oauth_authorization_attempts_mode_check",
      sql`${table.mode} in ('create', 'reconnect')`
    ),
    check(
      "oauth_authorization_attempts_status_check",
      sql`${table.status} in ('pending', 'processing', 'succeeded', 'failed')`
    ),
    index("oauth_authorization_attempts_integration_id_idx").on(
      table.integrationId
    ),
    index("oauth_authorization_attempts_expires_at_idx").on(table.expiresAt),
  ]
);

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
    /**
     * The version this run walks: a published one, or the snapshot a draft run
     * minted for itself. Every Execution pins one, including a terminal row that
     * never ran the graph. Readers (run panel, logs) resolve node ids against
     * this graph rather than the live draft column. Cascade with the
     * version so a workflow delete cannot race sibling cascades against a
     * required pin.
     */
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
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
    startEventName: text("start_event_name"),
    entityValue: text("entity_value"),
    input: jsonb("input").$type<JsonObject>(),
    // What the run finished with. A terminal row written without executing the
    // graph puts its verdict here instead, so this is not always a node output.
    output: jsonb("output").$type<JsonValue>(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().default(utcNow()),
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
    index("workflow_executions_in_flight_by_entity_idx")
      .on(table.workflowId, table.entityValue, table.runMode)
      .where(sql`${table.status} in (${sql.raw(inFlightStatusLiterals)})`),
    // workflow_version_id cascades from workflow_versions, and this is the
    // largest table in the schema: without this index, deleting a version
    // scans every execution row to find the ones the cascade must remove.
    index("workflow_executions_workflow_version_id_idx").on(
      table.workflowVersionId
    ),
  ]
);

/**
 * Which workflows care about which Events, derived from their published graphs.
 *
 * The listener set is app-wide, so a delivered Event needs one indexed lookup to
 * find the workflows it concerns rather than a scan of every stored graph. The
 * rows are rewritten on publish from the published graph. Connection and
 * Correlation Path ride on the row so a delivery matches without reading the
 * graph column. Draft saves leave this index alone.
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
    /**
     * The Connection an integration-owned Event must arrive on. Null for a
     * host Event. Delivery matches this from the index instead of reading the
     * graph the rules sit in, the same way `correlationPath` already does.
     */
    connectionId: text("connection_id"),
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
    // `cancelled` is written by the sweep that closes what a killed branch run
    // left open, and read by the status poll, which maps an open row of a
    // terminal run onto the same word. The column is text with no check
    // constraint, so the vocabulary widens without a migration.
    status: text("status")
      .notNull()
      .$type<"pending" | "running" | "success" | "error" | "cancelled">(),
    // Both are whatever the node handled, scrubbed by `redactSensitiveData` on
    // the way here. A step's payload is JSON but need not be an object: an
    // output schema encoding to a list or a string is stored as it stands.
    input: jsonb("input").$type<JsonValue>(),
    output: jsonb("output").$type<JsonValue>(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().default(utcNow()),
    completedAt: timestamp("completed_at"),
    duration: text("duration"),
    timestamp: timestamp("timestamp").notNull().default(utcNow()),
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
      .$type<"waiting" | "resuming" | "resumed" | "timed_out" | "cancelled">(),
    /**
     * What the authenticated runs panel uses to address this parked run.
     * Generated per park so concurrent runs at the same node cannot collide.
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
    metadata: jsonb("metadata").$type<JsonObject>(),
    createdAt: timestamp("created_at").notNull().default(utcNow()),
    // While `resuming`, this is the claim's lease timestamp and fencing token.
    // Settling the claim replaces it with the actual resume time.
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
    metadata: jsonb("metadata").$type<JsonObject>(),
    createdAt: timestamp("created_at").notNull().default(utcNow()),
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
    // Each runs-panel audit category filters by workflow and type before it
    // reads its newest 50 rows. A backward scan supplies the descending order.
    index("workflow_execution_events_workflow_type_created_at_idx").on(
      table.workflowId,
      table.eventType,
      table.createdAt
    ),
  ]
);

/**
 * Every table the schema module declares. `defineRelations` and the kit-safe
 * bag for `db.query` both take this object, so a table added below is one edit
 * rather than a silent hole in the relational surface.
 */
export const tables = {
  workflows,
  workflowVersions,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionEvents,
  workflowWaitStates,
  workflowEventSubscriptions,
  integrations,
  oauthAuthorizationAttempts,
};

/**
 * Relational Queries v2 config. `db.query` is keyed off this, so every table a
 * repository reads through that API has to appear here even when it has no
 * edges of its own.
 */
export const relations = defineRelations(tables, (r) => ({
  workflows: {
    publishedVersion: r.one.workflowVersions({
      from: r.workflows.publishedVersionId,
      to: r.workflowVersions.id,
    }),
  },
  workflowExecutions: {
    workflow: r.one.workflows({
      from: r.workflowExecutions.workflowId,
      to: r.workflows.id,
    }),
    version: r.one.workflowVersions({
      from: r.workflowExecutions.workflowVersionId,
      to: r.workflowVersions.id,
    }),
  },
  workflowVersions: {
    workflow: r.one.workflows({
      from: r.workflowVersions.workflowId,
      to: r.workflows.id,
    }),
  },
}));

export type Workflow = typeof workflows.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
/**
 * A version a Publish minted, the only kind that carries a number.
 * `workflows.published_version_id` always names one of these, so reads that
 * follow the pointer return this type and their callers can show the version
 * number without a null check.
 */
export type PublishedWorkflowVersion = WorkflowVersion & { version: number };
export type NewIntegration = typeof integrations.$inferInsert;
