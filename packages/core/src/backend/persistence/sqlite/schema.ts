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

const caseInsensitiveText = customType<{ data: string }>({
  dataType: () => "text COLLATE NOCASE",
});

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
  },
  (table) => [
    uniqueIndex("workflow_versions_workflow_id_version_uidx").on(
      table.workflowId,
      table.version
    ),
    check(
      "workflow_versions_kind_check",
      sql`${table.kind} in ('published', 'draft_snapshot')`
    ),
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
    workflowRunId: text("workflow_run_id").unique(),
    status: text("status").notNull(),
    startSource: text("start_source"),
    deliveryId: text("delivery_id"),
    enqueuedAt: integer("enqueued_at"),
    runMode: text("run_mode").notNull().default("live"),
    startEventName: text("start_event_name"),
    entityValue: text("entity_value"),
    input: text("input"),
    output: text("output"),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    waitingAt: integer("waiting_at"),
    cancelledAt: integer("cancelled_at"),
    completedAt: integer("completed_at"),
    duration: text("duration"),
    cancelRequestedAt: integer("cancel_requested_at"),
    cancelEventName: text("cancel_event_name"),
    cancelPayload: text("cancel_payload"),
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
    index("executions_workflow_in_flight_version_started_idx")
      .on(table.workflowId, table.workflowVersionId, table.startedAt)
      .where(sql`${table.status} in ('pending', 'running', 'waiting')`),
    check(
      "workflow_executions_status_check",
      sql`${table.status} in ('pending', 'running', 'waiting', 'completed', 'failed', 'canceled', 'superseded')`
    ),
    check(
      "workflow_executions_start_source_check",
      sql`${table.startSource} is null or ${table.startSource} in ('event', 'manual', 'schedule')`
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
  },
  (table) => [
    index("logs_execution_timestamp_idx").on(
      table.executionId,
      table.timestamp
    ),
    check(
      "workflow_execution_logs_status_check",
      sql`${table.status} in ('pending', 'running', 'success', 'error', 'cancelled')`
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
    runId: text("run_id").notNull(),
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
  },
  (table) => [
    index("waits_execution_status_idx").on(table.executionId, table.status),
    index("waits_workflow_status_idx").on(table.workflowId, table.status),
    check(
      "workflow_wait_states_wait_type_check",
      sql`${table.waitType} in ('delay', 'event')`
    ),
    check(
      "workflow_wait_states_status_check",
      sql`${table.status} in ('waiting', 'resuming', 'resumed', 'timed_out', 'cancelled')`
    ),
    check(
      "workflow_wait_states_subscribed_events_json_check",
      sql`json_valid(${table.subscribedEvents}) and json_type(${table.subscribedEvents}) = 'array'`
    ),
    check(
      "workflow_wait_states_metadata_json_check",
      sql`${table.metadata} is null or (json_valid(${table.metadata}) and json_type(${table.metadata}) = 'object')`
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
      sql`${table.refreshState} in ('idle', 'refreshing', 'reauthorization_required')`
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
  workflowExecutionEvents,
  integrations,
  oauthAuthorizationAttempts,
};
