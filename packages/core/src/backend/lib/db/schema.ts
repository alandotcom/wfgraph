import { defineRelations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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
  ENTITY_ELIGIBILITY_REASONS,
  type EntityEligibilityReason,
  IN_FLIGHT_EXECUTION_STATUSES,
  type NodeLogStatus,
  STORED_NODE_LOG_STATUSES,
  type TerminationKind,
  WORKFLOW_EXECUTION_STATUSES,
  type WorkflowExecutionStartSource,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";
import {
  EXECUTION_SCHEDULE_KINDS,
  EXECUTION_SCHEDULE_STATES,
  type ExecutionScheduleKind,
  type ExecutionScheduleState,
  type ParkWake,
  STEP_MEMO_STATUSES,
  type StepMemoStatus,
  WAIT_STATE_STATUSES,
  type WaitStateStatus,
} from "@wfgraph/shared/lifecycle/execution-schedule";
import {
  EVENT_INBOX_STATUSES,
  type EventInboxStatus,
} from "@wfgraph/shared/lifecycle/event-inbox";

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

/**
 * A closed list of lower-case words from shared, as the SQL literals a check
 * or a partial index names. `sql.raw` interpolates it as written, which is
 * safe because no member can carry a quote. A predicate built from the list
 * a query guards on cannot drift from that query.
 */
function literals(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

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
    check("workflows_mode_check", sql`${table.mode} in ('live', 'test')`),
    check(
      "workflows_visibility_check",
      sql`${table.visibility} in ('private', 'public')`
    ),
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
    /**
     * When a Draft run last pinned this draft snapshot: `freezeDraftSnapshot`
     * sets it when it inserts the row and again each time it hands the row to
     * another run. Null on a published version. The retention sweep reads it,
     * so a snapshot a run is about to pin is younger than any window.
     */
    lastPinnedAt: timestamp("last_pinned_at"),
  },
  (table) => [
    uniqueIndex("workflow_versions_workflow_id_version_uidx").on(
      table.workflowId,
      table.version
    ),
    check(
      "workflow_versions_kind_check",
      sql`${table.kind} in (${literals(WORKFLOW_VERSION_KINDS)})`
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
    // Only a draft snapshot is pinned by a Draft run, and every one has been.
    check(
      "workflow_versions_last_pinned_kind_check",
      sql`(${table.kind} = 'draft_snapshot') = (${table.lastPinnedAt} is not null)`
    ),
    // The retention sweep's scan of draft snapshots, least recently pinned
    // first. A published version is never swept, so the index leaves it out.
    index("workflow_versions_draft_snapshot_last_pinned_at_idx")
      .on(table.lastPinnedAt)
      .where(sql`${table.kind} = 'draft_snapshot'`),
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
      sql`${table.refreshState} in (${literals(INTEGRATION_REFRESH_STATES)})`
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
     * never ran the graph. Readers (Runs view, logs) resolve node ids against
     * this graph rather than the live draft column. Cascade with the
     * version so a workflow delete cannot race sibling cascades against a
     * required pin.
     */
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull().$type<WorkflowExecutionStatus>(),
    startSource: text("start_source")
      .notNull()
      .$type<WorkflowExecutionStartSource>(),
    // The arrival this run answers, which is what makes opening it idempotent:
    // a retried delivery re-runs its lifecycle step, and that attempt re-claims
    // this row instead of opening a second run for one Event.
    // Null for a manual or scheduled start, which no retry loop replays.
    deliveryId: text("delivery_id"),
    runMode: text("run_mode").notNull().default("live").$type<WorkflowMode>(),
    startEventName: text("start_event_name"),
    entityValue: text("entity_value"),
    // Stable host-owned identity for a workflow guarded by Entity Eligibility.
    // `entityValue` remains the legacy untyped correlation value.
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    input: jsonb("input").$type<JsonObject>(),
    // What the run finished with. A terminal row written without executing the
    // graph puts its verdict here instead, so this is not always a node output.
    output: jsonb("output").$type<JsonValue>(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull().default(utcNow()),
    /**
     * The slot a scheduled run fired for: the latest time its cron schedule
     * named at or before the fire. Null on every run a schedule did not start.
     * A fire claimed late runs once, for the latest slot, so this can sit
     * before `started_at`.
     */
    scheduledFor: timestamp("scheduled_for"),
    /**
     * The cron schedule that started a scheduled run: its expression and the
     * IANA zone it reads time in, which together identify the schedule. The
     * Runs view describes the run by them. `workflow_executions_schedule_check`
     * holds them and `scheduled_for` to all set, on a run whose start source
     * is `schedule`, or all null.
     */
    scheduleCron: text("schedule_cron"),
    scheduleTimeZone: text("schedule_time_zone"),
    waitingAt: timestamp("waiting_at"),
    cancelledAt: timestamp("cancelled_at"),
    completedAt: timestamp("completed_at"),
    duration: text("duration"),
    // The first execution-boundary decision. Cancel routes the parent through
    // its Canceled outlet; exit stops Started-side scheduling without an outlet.
    // The terminal status is written only after the parent cleans up open work.
    terminationKind: text("termination_kind").$type<TerminationKind>(),
    terminationRequestedAt: timestamp("termination_requested_at"),
    terminationReason:
      text("termination_reason").$type<EntityEligibilityReason>(),
    terminationNodeId: text("termination_node_id"),
    cancelEventName: text("cancel_event_name"),
    cancelPayload: jsonb("cancel_payload").$type<JsonObject>(),
    // The delivery that wrote the Cancel claim, so a retried delivery answers
    // the runs its own first attempt claimed. Null when the arrival carried no
    // delivery id.
    cancelDeliveryId: text("cancel_delivery_id"),
  },
  (table) => [
    check(
      "workflow_executions_status_check",
      sql`${table.status} in (${literals(WORKFLOW_EXECUTION_STATUSES)})`
    ),
    check(
      "workflow_executions_entity_identity_pair_check",
      sql`(${table.entityType} is null and ${table.entityId} is null) or (${table.entityType} is not null and ${table.entityId} is not null)`
    ),
    check(
      "workflow_executions_termination_check",
      sql`(${table.terminationKind} is null and ${table.terminationRequestedAt} is null and ${table.terminationReason} is null and ${table.terminationNodeId} is null and ${table.cancelEventName} is null and ${table.cancelPayload} is null and ${table.cancelDeliveryId} is null) or (${table.terminationKind} = 'cancel' and ${table.terminationRequestedAt} is not null and ${table.terminationReason} is null and ${table.terminationNodeId} is null) or (${table.terminationKind} = 'exit' and ${table.terminationRequestedAt} is not null and ${table.terminationReason} in (${literals(ENTITY_ELIGIBILITY_REASONS)}) and ${table.terminationNodeId} is not null and ${table.cancelEventName} is null and ${table.cancelPayload} is null and ${table.cancelDeliveryId} is null)`
    ),
    check(
      "workflow_executions_schedule_check",
      sql`(${table.scheduledFor} is null and ${table.scheduleCron} is null and ${table.scheduleTimeZone} is null) or (${table.scheduledFor} is not null and ${table.scheduleCron} is not null and ${table.scheduleTimeZone} is not null and ${table.startSource} = 'schedule')`
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
    // The Refused Starts toggle's count, on the Runs view's two-second poll.
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
      .where(
        sql`${table.status} in (${literals(IN_FLIGHT_EXECUTION_STATUSES)})`
      ),
    index("workflow_executions_in_flight_by_typed_entity_idx")
      .on(table.workflowId, table.entityType, table.entityId, table.runMode)
      .where(
        sql`${table.status} in (${literals(IN_FLIGHT_EXECUTION_STATUSES)})`
      ),
    // workflow_version_id cascades from workflow_versions, and this is the
    // largest table in the schema: without this index, deleting a version
    // scans every execution row to find the ones the cascade must remove.
    index("workflow_executions_workflow_version_id_idx").on(
      table.workflowVersionId
    ),
    // The retention sweep's scan, oldest ended run first. Only an ended run
    // carries `completed_at`, so the in-flight rows stay out of the index.
    index("workflow_executions_completed_at_idx")
      .on(table.completedAt)
      .where(sql`${table.completedAt} is not null`),
  ]
);

/**
 * Which workflows care about which Events, derived from their published graphs.
 *
 * The catalog is app-wide, so a delivered Event needs one indexed lookup to
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
    // No write stores `cancelled`. The status poll answers it for a row still
    // open on a stopped run, mapping an open row of a terminal run onto that
    // word.
    status: text("status").notNull().$type<NodeLogStatus>(),
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
    /**
     * How many times the database executor retried the node's durable steps
     * before the row closed: each retriable failure of one of them that
     * another try followed. Written when the row closes, from the step memo
     * rows carrying this node's id, and zero while the row is open.
     */
    retries: integer("retries").notNull().default(0),
    /**
     * The outlet handle a completed node released its outgoing edges through,
     * so a row can say which branch the run took below it. Null while the node
     * runs, for a node that released every edge, and for one that released none.
     */
    releasedOutlet: text("released_outlet"),
  },
  (table) => [
    check(
      "workflow_execution_logs_status_check",
      sql`${table.status} in (${literals(STORED_NODE_LOG_STATUSES)})`
    ),
    index("workflow_execution_logs_execution_id_idx").on(table.executionId),
    // A node has one log row per run: `nodeLogId` derives the row id from the
    // two, and the executor-state reads join a node's name on them.
    uniqueIndex("workflow_execution_logs_execution_node_uidx").on(
      table.executionId,
      table.nodeId
    ),
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
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    waitType: text("wait_type").notNull().$type<"delay" | "event">(),
    status: text("status").notNull().$type<WaitStateStatus>(),
    /**
     * What the authenticated Runs view uses to address this parked run.
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
    // Set when an Event or a manual resume claims the row, and read back as
    // when that wake arrived. No other wake sets it, and no write guards on
    // it. The Wait settling the row writes the time it resumed or timed out
    // here, and clears it when it cancels the row.
    resumedAt: timestamp("resumed_at"),
    cancelledAt: timestamp("cancelled_at"),
    /** The durable step that parked on this row, which reads `wake` back. */
    parkStepId: text("park_step_id"),
    /**
     * How the park was resolved: null while it is parked, and set once by the
     * producer that won the row (an Event, a deadline, a claim or a Migration).
     * A row holding a wake while its status is `resuming` is a wake no pass has
     * consumed yet.
     */
    wake: jsonb("wake").$type<ParkWake>(),
  },
  (table) => [
    check(
      "workflow_wait_states_status_check",
      sql`${table.status} in (${literals(WAIT_STATE_STATUSES)})`
    ),
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

/**
 * The event inbox: one row per Event arrival. The row is the durable record of
 * the arrival, and its id is the `delivery_id` every run the arrival opens
 * carries. A `pending` row has one `delivery` schedule row, which the executor
 * claims to deliver it; settling the delivery marks the row `delivered` or
 * `failed` and deletes that schedule row with its step memo.
 *
 * A host that shares this database raises an Event inside its own transaction
 * with one statement, the same on both backends:
 *
 *   insert into workflow_event_inbox (name, data, idempotency_key, connection_id)
 *   values ($1, $2, $3, $4)
 *   on conflict do nothing
 *
 * `name` and `data` are required. `name` is the name of an Event the host
 * declared, or the `source.event` name such Events arrive under, in which case
 * each Event's `source.when` decides which Event the row is; `data` is the
 * payload as a JSON object. `connection_id` names the Connection an
 * integration-owned Event arrived through, and only webhook intake writes it:
 * a row without one that names an integration-owned Event settles as
 * `failed` when the executor delivers it. `idempotency_key` is optional: a second row with the same name,
 * Connection and key is refused while the first row exists, and
 * `on conflict do nothing` turns that refusal into a no-op.
 * `id` defaults to a random UUID, and a host may set its own. The host leaves
 * `received_at` and `status` to their defaults, the insert time and `pending`,
 * and writes no schedule row: the executor's poll (`scheduleUnscheduledInbox`)
 * gives every `pending` row without one a schedule row, so the arrival is
 * delivered after the host's transaction commits and the next poll runs.
 */
export const workflowEventInbox = pgTable(
  "workflow_event_inbox",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    name: text("name").notNull(),
    data: jsonb("data").notNull().$type<JsonObject>(),
    connectionId: text("connection_id"),
    idempotencyKey: text("idempotency_key"),
    receivedAt: timestamp("received_at").notNull().default(utcNow()),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<EventInboxStatus>(),
    /** Why the delivery failed for good, on a `failed` row, and null otherwise. */
    error: text("error"),
    /** When the delivery settled, on a `delivered` or `failed` row. */
    settledAt: timestamp("settled_at"),
  },
  (table) => [
    check(
      "workflow_event_inbox_status_check",
      sql`${table.status} in (${literals(EVENT_INBOX_STATUSES)})`
    ),
    check(
      "workflow_event_inbox_settled_check",
      sql`(${table.status} = 'pending' and ${table.settledAt} is null and ${table.error} is null) or (${table.status} = 'delivered' and ${table.settledAt} is not null and ${table.error} is null) or (${table.status} = 'failed' and ${table.settledAt} is not null and ${table.error} is not null)`
    ),
    check(
      "workflow_event_inbox_data_check",
      sql`jsonb_typeof(${table.data}) = 'object'`
    ),
    // The idempotency key is unique per Event name and Connection. A row with
    // no Connection counts as the empty string here, which no Connection id
    // is, so two rows without a Connection still collide on their key while
    // two Connections receiving the same vendor id stay distinct. A row with
    // no key is never a duplicate.
    uniqueIndex("workflow_event_inbox_idempotency_uidx")
      .on(
        table.name,
        sql`coalesce(${table.connectionId}, '')`,
        table.idempotencyKey
      )
      .where(sql`${table.idempotencyKey} is not null`),
    // The poll's question: the oldest rows still waiting to be delivered.
    index("workflow_event_inbox_pending_idx")
      .on(table.receivedAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    // The retention sweep's question: settled rows past the window.
    index("workflow_event_inbox_settled_idx")
      .on(table.receivedAt)
      .where(sql`${table.status} <> 'pending'`),
  ]
);

/**
 * The decision one Cancel arrival made for one workflow: a row per workflow
 * and inbox row whose Cancel claim has committed, written in the claim's own
 * transaction whether or not it flagged a run. A retried delivery that finds
 * the row flags nothing new and answers with the runs the first attempt
 * flagged, which carry the inbox id in `cancel_delivery_id`, so one arrival
 * never cancels a run that opened after it was first applied. The rows go with
 * their inbox row when the retention sweep deletes it.
 */
export const workflowCancelDecisions = pgTable(
  "workflow_cancel_decisions",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => workflowEventInbox.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    decidedAt: timestamp("decided_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deliveryId, table.workflowId] })]
);

/**
 * One claimable row per body the database executor still has to run: a
 * workflow run, which names its Execution, an Event's delivery, which names
 * its inbox row, or a cron schedule's timer, which names its workflow and its
 * schedule.
 *
 * A worker claims a due row under a lease, replays the body against the step
 * memo the row owns, and releases the row as `queued` or `waiting`. A run's
 * terminal write deletes its row, and a settled delivery deletes its own, and
 * the memo rows go with each, so the table holds the working set and its
 * partial indexes stay small. A timer row lives while its schedule can fire:
 * Publish writes and deletes timer rows, pause deletes them, resume writes
 * them again, and each fire moves its row's `wake_at` to the next slot.
 */
export const workflowExecutionSchedule = pgTable(
  "workflow_execution_schedule",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    kind: text("kind").notNull().$type<ExecutionScheduleKind>(),
    /**
     * The run this row schedules. A `run` row always names one, and at most one
     * row names each Execution. A `delivery` row names none.
     */
    executionId: text("execution_id").references(() => workflowExecutions.id, {
      onDelete: "cascade",
    }),
    /**
     * The inbox row this row delivers. A `delivery` row always names one, and
     * at most one row names each inbox row. A `run` row names none.
     */
    inboxId: text("inbox_id").references(() => workflowEventInbox.id, {
      onDelete: "cascade",
    }),
    /**
     * The workflow whose schedule a `cron` row times. Only a `cron` row names
     * one; a `run` or `delivery` row reaches its workflow through its subject.
     */
    workflowId: text("workflow_id").references(() => workflows.id, {
      onDelete: "cascade",
    }),
    /**
     * The 5-field cron expression and the IANA time zone of the schedule a
     * `cron` row times. The pair identifies the schedule within its workflow,
     * as the Lifecycle Rules key it. Null on every other kind.
     */
    cron: text("cron"),
    timeZone: text("time_zone"),
    state: text("state").notNull().$type<ExecutionScheduleState>(),
    /**
     * When the row is due. Queued: now, or the end of a retry backoff. Waiting:
     * the earliest deadline among the run's open parks, or a timer's next slot.
     */
    wakeAt: timestamp("wake_at").notNull(),
    /**
     * The run's own failure count: leases that expired while no step was
     * recorded as running, and failures of the body that no step owns. A
     * failing step counts against its own memo row instead. Every other
     * release resets it to zero.
     */
    attempt: integer("attempt").notNull().default(0),
    /**
     * The step the pass holding the lease is running, as its heartbeat last
     * recorded it, and null between steps. A lease that expires counts one
     * failure against this step's memo row.
     */
    runningStepId: text("running_step_id"),
    /**
     * The node `running_step_id` does work for, recorded beside it, and null
     * between steps or for a step of no node. A lease that expires counts its
     * failure on a memo row carrying this node id.
     */
    runningNodeId: text("running_node_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    /**
     * The fencing token of the pass holding the lease, minted per claim. Every
     * write a pass makes is refused once this no longer names that pass.
     */
    ownerToken: text("owner_token"),
    workerId: text("worker_id"),
    lastError: text("last_error"),
  },
  (table) => [
    check(
      "workflow_execution_schedule_kind_check",
      sql`${table.kind} in (${literals(EXECUTION_SCHEDULE_KINDS)})`
    ),
    check(
      "workflow_execution_schedule_state_check",
      sql`${table.state} in (${literals(EXECUTION_SCHEDULE_STATES)})`
    ),
    check(
      "workflow_execution_schedule_subject_check",
      sql`(${table.kind} = 'run' and ${table.executionId} is not null and ${table.inboxId} is null and ${table.workflowId} is null and ${table.cron} is null and ${table.timeZone} is null) or (${table.kind} = 'delivery' and ${table.inboxId} is not null and ${table.executionId} is null and ${table.workflowId} is null and ${table.cron} is null and ${table.timeZone} is null) or (${table.kind} = 'cron' and ${table.workflowId} is not null and ${table.cron} is not null and ${table.timeZone} is not null and ${table.executionId} is null and ${table.inboxId} is null)`
    ),
    // A lease is the three columns a claim writes together and a release or
    // a timer's move clears together, and a running step exists only under it.
    check(
      "workflow_execution_schedule_lease_check",
      sql`(${table.state} = 'leased' and ${table.ownerToken} is not null and ${table.leaseExpiresAt} is not null and ${table.workerId} is not null) or (${table.state} <> 'leased' and ${table.ownerToken} is null and ${table.leaseExpiresAt} is null and ${table.workerId} is null and ${table.runningStepId} is null and ${table.runningNodeId} is null)`
    ),
    uniqueIndex("workflow_execution_schedule_execution_uidx").on(
      table.executionId
    ),
    uniqueIndex("workflow_execution_schedule_inbox_uidx").on(table.inboxId),
    // One timer per schedule. A row of another kind leaves the three columns
    // null, and nulls are distinct in a unique index, so only timers collide.
    uniqueIndex("workflow_execution_schedule_cron_uidx").on(
      table.workflowId,
      table.cron,
      table.timeZone
    ),
    // The claim's question: the due rows, oldest first.
    index("workflow_execution_schedule_due_idx")
      .on(table.wakeAt, table.id)
      .where(sql`${table.state} in ('queued', 'waiting')`),
    // The claim's other question: the leases a dead worker left to expire.
    index("workflow_execution_schedule_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'leased'`),
  ]
);

/**
 * The step memo: one row per durable step a schedule row's body has reached,
 * keyed by that schedule row. A pass loads every row before it replays the
 * body. A `succeeded` row answers the step with its value instead of running
 * it again; a `failing` row counts the step's failures so far, and the step
 * runs again; a `failed` row fails the step on every pass. Deleting the
 * schedule row deletes its memo.
 */
export const workflowExecutionSteps = pgTable(
  "workflow_execution_steps",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => workflowExecutionSchedule.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    /**
     * The node the step does work for, as the engine named it when the step
     * ran, and null for a step of no node, such as a delivery's step or a
     * run-level step. Step ids are not parsed for it, because their shapes
     * differ by the code that names them.
     */
    nodeId: text("node_id"),
    status: text("status").notNull().$type<StepMemoStatus>(),
    /**
     * The retriable failures counted against this step: each time it threw,
     * and each lease that expired while it ran. A step that later succeeded
     * keeps the count it reached.
     */
    failures: integer("failures").notNull().default(0),
    /** The step's answer when `succeeded`, and null otherwise. */
    value: jsonb("value").$type<JsonValue>(),
    /** The step's last failure when `failing` or `failed`, and null otherwise. */
    error: text("error"),
    createdAt: timestamp("created_at").notNull().default(utcNow()),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleId, table.stepId] }),
    check(
      "workflow_execution_steps_status_check",
      sql`${table.status} in (${literals(STEP_MEMO_STATUSES)})`
    ),
    check(
      "workflow_execution_steps_error_check",
      sql`(${table.status} = 'succeeded') = (${table.error} is null)`
    ),
    check(
      "workflow_execution_steps_value_check",
      sql`${table.status} = 'succeeded' or ${table.value} is null`
    ),
    // A failing or failed row counts the failure that made it. The count is
    // not held to STEP_RETRY_LIMIT, which is policy a deploy may change.
    check(
      "workflow_execution_steps_failures_check",
      sql`${table.failures} >= 0 and (${table.status} = 'succeeded' or ${table.failures} > 0)`
    ),
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
    // The identity sort key the audit readers order on after `created_at`.
    // `created_at` defaults from now(), which is the transaction start, so every
    // row a transaction writes carries the same timestamp and the timeline has
    // no order of its own. Postgres draws this column from a sequence, so it
    // grows with each insert and settles a tie in insertion order. The SQLite
    // schema carries no matching column: its rowid already is that sequence.
    // Nothing outside this table reads the value, and the repository leaves it
    // out of every row it returns.
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (table) => [
    index("workflow_execution_events_workflow_created_at_idx").on(
      table.workflowId,
      table.createdAt,
      table.seq
    ),
    index("workflow_execution_events_execution_created_at_idx").on(
      table.executionId,
      table.createdAt,
      table.seq
    ),
    // Each runs-panel audit category filters by workflow and type before it
    // reads its newest 50 rows. A backward scan supplies the descending order,
    // which is why `seq` is in each of these three indexes: the readers order
    // on `created_at` and `seq` together, and an index holding only the first
    // of the two would leave Postgres sorting every matching row.
    index("workflow_execution_events_workflow_type_created_at_idx").on(
      table.workflowId,
      table.eventType,
      table.createdAt,
      table.seq
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
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowEventInbox,
  workflowCancelDecisions,
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
