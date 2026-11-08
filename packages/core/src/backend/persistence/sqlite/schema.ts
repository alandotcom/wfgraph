import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  ENTITY_ELIGIBILITY_REASONS,
  IN_FLIGHT_EXECUTION_STATUSES,
  NODE_LOG_STATUSES,
  type TerminationKind,
  WORKFLOW_EXECUTION_START_SOURCES,
  WORKFLOW_EXECUTION_STATUSES,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  EXECUTION_SCHEDULE_KINDS,
  EXECUTION_SCHEDULE_STATES,
  STEP_MEMO_STATUSES,
  WAIT_STATE_STATUSES,
} from "@wfgraph/shared/lifecycle/execution-schedule";
import { EVENT_INBOX_STATUSES } from "@wfgraph/shared/lifecycle/event-inbox";
import { INTEGRATION_REFRESH_STATES } from "@wfgraph/shared/types/integration";
import { WORKFLOW_VERSION_KINDS } from "@wfgraph/shared/graph/version-kinds";

const caseInsensitiveText = customType<{ data: string }>({
  dataType: () => "text COLLATE NOCASE",
});

/**
 * A closed list of lower-case words from shared, as the SQL literals a check
 * or a partial index names. `sql.raw` interpolates it as written, which is
 * safe because no member can carry a quote.
 */
function literals(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(", "));
}

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    name: caseInsensitiveText("name").notNull().unique(),
    description: text("description"),
    graph: text("graph").notNull(),
    draftRevision: integer("draft_revision").notNull().default(1),
    isPaused: integer("is_paused").notNull().default(0),
    mode: text("mode").notNull().default("live"),
    visibility: text("visibility").notNull().default("private"),
    publishedVersionId: text("published_version_id").references(
      (): AnySQLiteColumn => workflowVersions.id,
      { onDelete: "set null" }
    ),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Deleting a version runs the `on delete set null` action of this foreign
    // key, which finds the workflows naming that version through this index.
    index("workflows_published_version_idx").on(table.publishedVersionId),
    check("workflows_is_paused_check", sql`${table.isPaused} in (0, 1)`),
    check("workflows_mode_check", sql`${table.mode} in ('live', 'test')`),
    check(
      "workflows_visibility_check",
      sql`${table.visibility} in ('private', 'public')`
    ),
  ]
);

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version"),
    kind: text("kind").notNull().default("published"),
    graph: text("graph").notNull(),
    catalogFingerprint: text("catalog_fingerprint").notNull(),
    graphDigest: text("graph_digest").notNull(),
    publishedAt: integer("published_at").notNull(),
    lastPinnedAt: integer("last_pinned_at"),
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
    check(
      "workflow_versions_last_pinned_kind_check",
      sql`(${table.kind} = 'draft_snapshot') = (${table.lastPinnedAt} is not null)`
    ),
    // The retention sweep's scan of draft snapshots, least recently pinned
    // first. A published version is never swept, so the index leaves it out.
    index("versions_draft_snapshot_last_pinned_idx")
      .on(table.lastPinnedAt)
      .where(sql`${table.kind} = 'draft_snapshot'`),
  ]
);

export const workflowEventSubscriptions = sqliteTable(
  "workflow_event_subscriptions",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    eventName: text("event_name").notNull(),
    role: text("role").notNull(),
    correlationPath: text("correlation_path"),
    connectionId: text("connection_id"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowId, table.eventName, table.role] }),
    index("subscriptions_event_idx").on(table.eventName),
    check(
      "workflow_event_subscriptions_role_check",
      sql`${table.role} in ('start', 'cancel', 'wait')`
    ),
  ]
);

export const workflowExecutions = sqliteTable(
  "workflow_executions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    startSource: text("start_source").notNull(),
    deliveryId: text("delivery_id"),
    runMode: text("run_mode").notNull().default("live"),
    startEventName: text("start_event_name"),
    entityValue: text("entity_value"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    input: text("input"),
    output: text("output"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    scheduledFor: integer("scheduled_for"),
    scheduleCron: text("schedule_cron"),
    scheduleTimeZone: text("schedule_time_zone"),
    waitingAt: integer("waiting_at"),
    cancelledAt: integer("cancelled_at"),
    completedAt: integer("completed_at"),
    duration: text("duration"),
    terminationKind: text("termination_kind").$type<TerminationKind>(),
    terminationRequestedAt: integer("termination_requested_at"),
    terminationReason: text("termination_reason"),
    terminationNodeId: text("termination_node_id"),
    cancelEventName: text("cancel_event_name"),
    cancelPayload: text("cancel_payload"),
    // The delivery that wrote the Cancel claim, so a retried delivery answers
    // the runs its own first attempt claimed. Null when the arrival carried no
    // delivery id.
    cancelDeliveryId: text("cancel_delivery_id"),
  },
  (table) => [
    uniqueIndex("workflow_executions_workflow_id_delivery_id_uidx").on(
      table.workflowId,
      table.deliveryId
    ),
    index("executions_workflow_started_idx").on(
      table.workflowId,
      table.startedAt,
      table.id
    ),
    index("executions_started_idx").on(table.startedAt, table.id),
    index("executions_entity_idx").on(
      table.workflowId,
      table.entityValue,
      table.runMode,
      table.status
    ),
    index("executions_typed_entity_idx").on(
      table.workflowId,
      table.entityType,
      table.entityId,
      table.runMode,
      table.status
    ),
    index("executions_workflow_in_flight_version_started_idx")
      .on(table.workflowId, table.workflowVersionId, table.startedAt)
      .where(
        sql`${table.status} in (${literals(IN_FLIGHT_EXECUTION_STATUSES)})`
      ),
    // Deleting a version finds its runs through this index, for the cascade
    // and for the check that a draft snapshot is unreferenced.
    index("executions_workflow_version_idx").on(table.workflowVersionId),
    // The retention sweep's scan, oldest ended run first. Only an ended run
    // carries `completed_at`, so the in-flight rows stay out of the index.
    index("executions_completed_idx")
      .on(table.completedAt)
      .where(sql`${table.completedAt} is not null`),
    check(
      "workflow_executions_status_check",
      sql`${table.status} in (${literals(WORKFLOW_EXECUTION_STATUSES)})`
    ),
    check(
      "workflow_executions_entity_identity_pair_check",
      sql`(${table.entityType} is null and ${table.entityId} is null) or (${table.entityType} is not null and ${table.entityId} is not null)`
    ),
    check(
      "workflow_executions_schedule_check",
      sql`(${table.scheduledFor} is null and ${table.scheduleCron} is null and ${table.scheduleTimeZone} is null) or (${table.scheduledFor} is not null and ${table.scheduleCron} is not null and ${table.scheduleTimeZone} is not null and ${table.startSource} = 'schedule')`
    ),
    // Unlike PostgreSQL's, this leaves the Cancel arrival's columns free. A
    // legacy database's Cancel claims are restored only after every pending
    // migration has run, so a rebuild holding them would refuse those rows.
    check(
      "workflow_executions_termination_check",
      sql`(${table.terminationKind} is null and ${table.terminationRequestedAt} is null and ${table.terminationReason} is null and ${table.terminationNodeId} is null) or (${table.terminationKind} = 'cancel' and ${table.terminationRequestedAt} is not null and ${table.terminationReason} is null and ${table.terminationNodeId} is null) or (${table.terminationKind} = 'exit' and ${table.terminationRequestedAt} is not null and ${table.terminationReason} in (${literals(ENTITY_ELIGIBILITY_REASONS)}) and ${table.terminationNodeId} is not null)`
    ),
    check(
      "workflow_executions_start_source_check",
      sql`${table.startSource} in (${literals(WORKFLOW_EXECUTION_START_SOURCES)})`
    ),
    check(
      "workflow_executions_run_mode_check",
      sql`${table.runMode} in ('live', 'test')`
    ),
    check(
      "workflow_executions_input_json_check",
      sql`${table.input} is null or json_valid(${table.input})`
    ),
    check(
      "workflow_executions_output_json_check",
      sql`${table.output} is null or json_valid(${table.output})`
    ),
    check(
      "workflow_executions_cancel_payload_json_check",
      sql`${table.cancelPayload} is null or json_valid(${table.cancelPayload})`
    ),
  ]
);

export const workflowExecutionLogs = sqliteTable(
  "workflow_execution_logs",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status").notNull(),
    input: text("input"),
    output: text("output"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    duration: text("duration"),
    timestamp: integer("timestamp").notNull(),
    retries: integer("retries").notNull().default(0),
    releasedOutlet: text("released_outlet"),
  },
  (table) => [
    index("logs_execution_timestamp_idx").on(
      table.executionId,
      table.timestamp
    ),
    uniqueIndex("logs_execution_node_uidx").on(table.executionId, table.nodeId),
    check(
      "workflow_execution_logs_status_check",
      sql`${table.status} in (${literals(NODE_LOG_STATUSES)})`
    ),
    check(
      "workflow_execution_logs_input_json_check",
      sql`${table.input} is null or json_valid(${table.input})`
    ),
    check(
      "workflow_execution_logs_output_json_check",
      sql`${table.output} is null or json_valid(${table.output})`
    ),
  ]
);

export const workflowWaitStates = sqliteTable(
  "workflow_wait_states",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    waitType: text("wait_type").notNull(),
    status: text("status").notNull(),
    resumeToken: text("resume_token").unique(),
    waitUntil: integer("wait_until"),
    subscribedEvents: text("subscribed_events").notNull().default("[]"),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    resumedAt: integer("resumed_at"),
    cancelledAt: integer("cancelled_at"),
    parkStepId: text("park_step_id"),
    // JSON text holding a `ParkWake`.
    wake: text("wake"),
  },
  (table) => [
    index("waits_execution_status_idx").on(table.executionId, table.status),
    index("waits_workflow_status_idx").on(table.workflowId, table.status),
    uniqueIndex("waits_execution_node_uidx").on(
      table.executionId,
      table.nodeId
    ),
    check(
      "workflow_wait_states_wait_type_check",
      sql`${table.waitType} in ('delay', 'event')`
    ),
    check(
      "workflow_wait_states_status_check",
      sql`${table.status} in (${literals(WAIT_STATE_STATUSES)})`
    ),
    check(
      "workflow_wait_states_subscribed_events_json_check",
      sql`json_valid(${table.subscribedEvents}) and json_type(${table.subscribedEvents}) = 'array'`
    ),
    check(
      "workflow_wait_states_metadata_json_check",
      sql`${table.metadata} is null or (json_valid(${table.metadata}) and json_type(${table.metadata}) = 'object')`
    ),
    check(
      "workflow_wait_states_wake_json_check",
      sql`${table.wake} is null or json_valid(${table.wake})`
    ),
    check(
      "workflow_wait_states_wake_check",
      sql`(${table.status} <> 'waiting' or ${table.wake} is null) and (${table.status} <> 'resuming' or ${table.wake} is not null)`
    ),
  ]
);

/**
 * The PostgreSQL event inbox in SQLite's encoding, with the payload as JSON
 * text and timestamps as epoch milliseconds. `workflowEventInbox` in
 * `lib/db/schema.ts` describes the columns, the idempotency index, and the
 * insert a host makes in its own transaction, which is the same statement
 * here. The defaults on `id`, `received_at` and `status` are what let that
 * statement leave them out.
 */
export const workflowEventInbox = sqliteTable(
  "workflow_event_inbox",
  {
    id: text("id")
      .primaryKey()
      .default(sql`(lower(hex(randomblob(16))))`),
    name: text("name").notNull(),
    data: text("data").notNull(),
    connectionId: text("connection_id"),
    idempotencyKey: text("idempotency_key"),
    receivedAt: integer("received_at")
      .notNull()
      .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    settledAt: integer("settled_at"),
  },
  (table) => [
    uniqueIndex("inbox_idempotency_uidx")
      .on(
        table.name,
        sql`coalesce(${table.connectionId}, '')`,
        table.idempotencyKey
      )
      .where(sql`${table.idempotencyKey} is not null`),
    index("inbox_pending_idx")
      .on(table.receivedAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index("inbox_settled_idx")
      .on(table.receivedAt)
      .where(sql`${table.status} <> 'pending'`),
    check(
      "workflow_event_inbox_status_check",
      sql`${table.status} in (${literals(EVENT_INBOX_STATUSES)})`
    ),
    check(
      "workflow_event_inbox_settled_check",
      sql`(${table.status} = 'pending' and ${table.settledAt} is null and ${table.error} is null) or (${table.status} = 'delivered' and ${table.settledAt} is not null and ${table.error} is null) or (${table.status} = 'failed' and ${table.settledAt} is not null and ${table.error} is not null)`
    ),
    check(
      "workflow_event_inbox_data_json_check",
      sql`json_valid(${table.data}) and json_type(${table.data}) = 'object'`
    ),
  ]
);

/**
 * The PostgreSQL cancel decision table in SQLite's encoding, with the decision
 * time as epoch milliseconds. `workflowCancelDecisions` in `lib/db/schema.ts`
 * describes the rows.
 */
export const workflowCancelDecisions = sqliteTable(
  "workflow_cancel_decisions",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => workflowEventInbox.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    decidedAt: integer("decided_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deliveryId, table.workflowId] })]
);

/**
 * The PostgreSQL schedule table in SQLite's encoding, with timestamps as epoch
 * milliseconds. `workflowExecutionSchedule` in `lib/db/schema.ts` describes the
 * columns.
 */
export const workflowExecutionSchedule = sqliteTable(
  "workflow_execution_schedule",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    executionId: text("execution_id").references(() => workflowExecutions.id, {
      onDelete: "cascade",
    }),
    inboxId: text("inbox_id").references(() => workflowEventInbox.id, {
      onDelete: "cascade",
    }),
    workflowId: text("workflow_id").references(() => workflows.id, {
      onDelete: "cascade",
    }),
    cron: text("cron"),
    timeZone: text("time_zone"),
    state: text("state").notNull(),
    wakeAt: integer("wake_at").notNull(),
    attempt: integer("attempt").notNull().default(0),
    runningStepId: text("running_step_id"),
    runningNodeId: text("running_node_id"),
    leaseExpiresAt: integer("lease_expires_at"),
    ownerToken: text("owner_token"),
    workerId: text("worker_id"),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("schedule_execution_uidx").on(table.executionId),
    uniqueIndex("schedule_inbox_uidx").on(table.inboxId),
    uniqueIndex("schedule_cron_uidx").on(
      table.workflowId,
      table.cron,
      table.timeZone
    ),
    index("schedule_due_idx")
      .on(table.wakeAt, table.id)
      .where(sql`${table.state} in ('queued', 'waiting')`),
    index("schedule_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'leased'`),
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
    check(
      "workflow_execution_schedule_lease_check",
      sql`(${table.state} = 'leased' and ${table.ownerToken} is not null and ${table.leaseExpiresAt} is not null and ${table.workerId} is not null) or (${table.state} <> 'leased' and ${table.ownerToken} is null and ${table.leaseExpiresAt} is null and ${table.workerId} is null and ${table.runningStepId} is null and ${table.runningNodeId} is null)`
    ),
  ]
);

/**
 * The PostgreSQL step memo in SQLite's encoding, with the value as JSON text and
 * the timestamp as epoch milliseconds. `workflowExecutionSteps` in
 * `lib/db/schema.ts` describes the columns.
 */
export const workflowExecutionSteps = sqliteTable(
  "workflow_execution_steps",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => workflowExecutionSchedule.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    nodeId: text("node_id"),
    status: text("status").notNull(),
    failures: integer("failures").notNull().default(0),
    value: text("value"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
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
      "workflow_execution_steps_value_json_check",
      sql`${table.value} is null or json_valid(${table.value})`
    ),
    check(
      "workflow_execution_steps_value_check",
      sql`${table.status} = 'succeeded' or ${table.value} is null`
    ),
    check(
      "workflow_execution_steps_failures_check",
      sql`${table.failures} >= 0 and (${table.status} = 'succeeded' or ${table.failures} > 0)`
    ),
  ]
);

export const workflowExecutionEvents = sqliteTable(
  "workflow_execution_events",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    executionId: text("execution_id").references(() => workflowExecutions.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("events_execution_created_idx").on(
      table.executionId,
      table.createdAt
    ),
    index("events_workflow_type_created_idx").on(
      table.workflowId,
      table.eventType,
      table.createdAt
    ),
    check(
      "workflow_execution_events_metadata_json_check",
      sql`${table.metadata} is null or (json_valid(${table.metadata}) and json_type(${table.metadata}) = 'object')`
    ),
  ]
);

export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    isManaged: integer("is_managed").default(0),
    refreshState: text("refresh_state").notNull().default("idle"),
    configRevision: integer("config_revision").notNull().default(0),
    refreshClaimId: text("refresh_claim_id"),
    refreshClaimedAt: integer("refresh_claimed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("integrations_type_idx").on(table.type),
    check(
      "integrations_is_managed_check",
      sql`${table.isManaged} is null or ${table.isManaged} in (0, 1)`
    ),
    check(
      "integrations_refresh_state_check",
      sql`${table.refreshState} in (${literals(INTEGRATION_REFRESH_STATES)})`
    ),
  ]
);

export const oauthAuthorizationAttempts = sqliteTable(
  "oauth_authorization_attempts",
  {
    stateHash: text("state_hash").primaryKey(),
    integrationId: text("integration_id").references(() => integrations.id, {
      onDelete: "cascade",
    }),
    expiresAt: integer("expires_at").notNull(),
    browserBindingHash: text("browser_binding_hash").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    resultIntegrationId: text("result_integration_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("oauth_attempts_integration_idx").on(table.integrationId),
    index("oauth_attempts_expires_at_idx").on(table.expiresAt),
    check(
      "oauth_authorization_attempts_mode_check",
      sql`${table.mode} in ('create', 'reconnect')`
    ),
    check(
      "oauth_authorization_attempts_status_check",
      sql`${table.status} in ('pending', 'processing', 'succeeded', 'failed')`
    ),
  ]
);

export const sqliteTables = {
  workflows,
  workflowVersions,
  workflowEventSubscriptions,
  workflowExecutions,
  workflowExecutionLogs,
  workflowWaitStates,
  workflowEventInbox,
  workflowCancelDecisions,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowExecutionEvents,
  integrations,
  oauthAuthorizationAttempts,
};
