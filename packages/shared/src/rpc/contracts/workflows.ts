import { asyncIteratorObject } from "@orpc/contract";
import { Schema } from "effect";
import { WfGraphOperations } from "#src/authorization/operations";
import {
  workflowMigrationInputSchema,
  workflowMigrationPayloadSchema,
  workflowMigrationPreviewInputSchema,
  workflowMigrationPreviewPayloadSchema,
} from "#src/graph/migration-contracts";
import {
  workflowComparisonInputSchema,
  workflowComparisonPayloadSchema,
  workflowPublishInputSchema,
  workflowRestoreVersionInputSchema,
  workflowVersionHistoryInputSchema,
  workflowVersionHistoryPayloadSchema,
  workflowVersionUsageInputSchema,
  workflowVersionUsagePayloadSchema,
} from "#src/graph/publication-contracts";
import { serializedWorkflowGraphSchema } from "#src/graph/schemas";
import { WORKFLOW_VERSION_KINDS } from "#src/graph/version-kinds";
import {
  ENTITY_ELIGIBILITY_REASONS,
  NODE_LOG_STATUSES,
  WORKFLOW_EXECUTION_IGNORED_REASONS,
  WORKFLOW_EXECUTION_START_SOURCES,
  WORKFLOW_EXECUTION_STATUSES,
} from "#src/lifecycle/execution-contracts";
import {
  EXECUTION_SCHEDULE_STATES,
  PARK_WAKE_KINDS,
} from "#src/lifecycle/execution-schedule";
import { jsonObjectSchema } from "#src/types/json";
import {
  listOf,
  NonEmptyTrimmedString,
  nonNegativeInteger,
  positiveInteger,
} from "#src/types/schema";
import { isoTimestampString } from "#src/types/timestamp";
import {
  contractSchema,
  deleted,
  idSchema,
  noInput,
  route,
} from "#src/rpc/contracts/contract-support";

// Everything here but `description` comes from a non-null column
// through the one mapper that builds this payload, so the client never has to
// invent a value or defend against `?? ""`. A consumer that feeds `id` straight
// to a router as a workflow id would have an empty string resolve to a route
// that redirects away.
/**
 * The most superseded runs one workflow's run list counts. `supersededCount`
 * counts one run past this and stops, so an answer above it means "more than
 * this many", and the two-second poll reading it costs the same however many
 * runs newer starts displaced.
 */
export const SUPERSEDED_COUNT_LIMIT = 1000;

export const workflowSummarySchema = Schema.Struct({
  id: idSchema,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  isPaused: Schema.Boolean,
  mode: Schema.Literals(["live", "test"]),
  visibility: Schema.Literals(["private", "public"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Absent until the first publish. */
  publishedVersionId: Schema.optionalKey(idSchema),
});

/**
 * One workflow in full. The graph is the whole difference from the summary
 * above, and it is why the list procedure answers with the summary: a stored
 * graph runs to megabytes, and the two screens that read the list show names.
 */
const workflowApiPayloadSchema = Schema.Struct({
  ...workflowSummarySchema.fields,
  graph: serializedWorkflowGraphSchema,
  draftRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  /** Absent until the first publish. */
  publishedVersion: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
  /** Absent until the first publish. */
  publishedAt: Schema.optionalKey(isoTimestampString()),
  /**
   * Whether the draft graph differs from the published version's graph.
   * False when the workflow has never been published. Lives on the full
   * payload only: computing it needs the draft graph, which the list omits.
   */
  hasUnpublishedChanges: Schema.Boolean,
});

const workflowPublishPayloadSchema = Schema.Struct({
  ...workflowApiPayloadSchema.fields,
  publishedVersionId: idSchema,
  publishedVersion: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThan(0)
  ),
  publishedAt: isoTimestampString(),
});

/**
 * The shapes more than one procedure answers with, bridged here rather than at
 * each `.output()`.
 *
 * `toStandardSchema` refuses a second crossing that carries parse options, and
 * these are the shapes that would otherwise ask for one. Binding the bridged
 * form is also what the schema means: one object, one set of decode options,
 * however many procedures hand it back.
 */
const workflowApiPayload = contractSchema(workflowApiPayloadSchema);
const workflowPublishPayload = contractSchema(workflowPublishPayloadSchema);
const workflowVersionHistoryInput = contractSchema(
  workflowVersionHistoryInputSchema
);
const workflowVersionHistoryPayload = contractSchema(
  workflowVersionHistoryPayloadSchema
);
const workflowVersionUsageInput = contractSchema(
  workflowVersionUsageInputSchema
);
const workflowVersionUsagePayload = contractSchema(
  workflowVersionUsagePayloadSchema
);
const workflowMigrationPreviewInput = contractSchema(
  workflowMigrationPreviewInputSchema
);
const workflowMigrationPreviewPayload = contractSchema(
  workflowMigrationPreviewPayloadSchema
);
const workflowMigrationInput = contractSchema(workflowMigrationInputSchema);
const workflowMigrationPayload = contractSchema(workflowMigrationPayloadSchema);
const workflowComparisonInput = contractSchema(workflowComparisonInputSchema);
const workflowComparisonPayload = contractSchema(
  workflowComparisonPayloadSchema
);
const workflowRestoreVersionInput = contractSchema(
  workflowRestoreVersionInputSchema
);

const workflowRunModeSchema = Schema.Literals(["live", "test"]);
const workflowVersionKindSchema = Schema.Literals(WORKFLOW_VERSION_KINDS);
const workflowExecutionStatusSchema = Schema.Literals(
  WORKFLOW_EXECUTION_STATUSES
);
const executionLogStatusSchema = Schema.Literals(NODE_LOG_STATUSES);

/** An instant the database executor reports, as an ISO 8601 string. */
const executorInstant = isoTimestampString();

/**
 * The node the database executor names in a run's activity or state. The id
 * is null for a step of no node, and the name is null when the run has no log
 * row for the node yet, in which case the pinned graph names it.
 */
const executorNodeFields = {
  nodeId: Schema.NullOr(Schema.String),
  nodeName: Schema.NullOr(Schema.String),
};

/** The wake a producer wrote onto a park. See `ParkWake`. */
const parkWakeKindSchema = Schema.Literals(PARK_WAKE_KINDS);

/**
 * The run waits until `nextTryAt` after a failure. A step's failure names the
 * step's node, counts that step's failures and carries its last `error`; a
 * failure outside any step names no node and counts the run's own. A step
 * gets `retryLimit` retries, so the next try is try `failures + 1` of
 * `retryLimit + 1`.
 */
const retryingActivitySchema = Schema.Struct({
  kind: Schema.Literal("retrying"),
  ...executorNodeFields,
  nextTryAt: executorInstant,
  failures: positiveInteger,
  retryLimit: positiveInteger,
  error: Schema.NullOr(Schema.String),
});

/**
 * The worker running the run stopped renewing its lease at `since`, while
 * running a step of the named node, and another worker will take the run over.
 */
const leaseExpiredActivitySchema = Schema.Struct({
  kind: Schema.Literal("lease_expired"),
  ...executorNodeFields,
  since: executorInstant,
});

/** The run has been due since `dueSince` and no worker has claimed it. */
const unclaimedActivitySchema = Schema.Struct({
  kind: Schema.Literal("unclaimed"),
  dueSince: executorInstant,
});

/**
 * What the database executor is doing about an in-progress run, as a runs list
 * shows it beside the run, or null when there is nothing to show: `retrying`,
 * `lease_expired` or `unclaimed`. The run's overview reads the same decision
 * from `executorStateSchema`.
 */
const runListActivitySchema = Schema.Union([
  retryingActivitySchema,
  leaseExpiredActivitySchema,
  unclaimedActivitySchema,
]);

/** See `runListActivitySchema`. */
export type RunListActivityView = (typeof runListActivitySchema)["Type"];

/**
 * What the database executor is doing about an in-progress run, as the run's
 * overview states it. The server decides which case holds (`executorActivityOf`
 * in @wfgraph/core gives the order the cases are tested in):
 *
 * - `resuming`: a producer resolved a park of the run (`wake` says which) and
 *   no pass has read the wake. `wokenAt` is when an Event or a manual resume
 *   claimed it, `deadline` is the park's deadline, and `unclaimedSince` is
 *   when the wake began waiting for a worker, null while a worker holds a live
 *   lease on the run.
 * - `lease_expired`: as in a runs list.
 * - `running`: a worker, `workerId`, holds a live lease, running a step of the
 *   named node. The node is the one the worker's last lease renewal recorded,
 *   so it is null between steps and for a while after a claim.
 * - `retrying`: as in a runs list.
 * - `unclaimed`: as in a runs list.
 * - `waiting`: the run is asleep on its parks and not yet due.
 */
const scheduleActivitySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("resuming"),
    nodeId: Schema.String,
    nodeName: Schema.String,
    wake: parkWakeKindSchema,
    eventName: Schema.NullOr(Schema.String),
    wokenAt: Schema.NullOr(executorInstant),
    deadline: Schema.NullOr(executorInstant),
    unclaimedSince: Schema.NullOr(executorInstant),
  }),
  leaseExpiredActivitySchema,
  Schema.Struct({
    kind: Schema.Literal("running"),
    ...executorNodeFields,
    workerId: Schema.NullOr(Schema.String),
  }),
  retryingActivitySchema,
  unclaimedActivitySchema,
  Schema.Struct({ kind: Schema.Literal("waiting") }),
]);

/**
 * The server's clock and threshold an answer carrying executor activity is
 * read against. `observedAt` is the server's clock when it answered, which is
 * what to measure how long a run has waited against. `overdueAfterMs` is how
 * long a due run may wait for a worker on this host before the Runs view
 * says no worker has claimed it, which depends on how often the host's
 * workers look for due runs.
 */
const executorReadingFields = {
  observedAt: executorInstant,
  overdueAfterMs: positiveInteger,
};

/**
 * How long the host keeps a run after it finishes, in milliseconds, before the
 * retention sweep deletes it, or null when the host keeps every run. Both run
 * lists carry it so the Runs view can say why old runs are gone.
 */
const runRetentionFields = {
  runRetentionMs: Schema.NullOr(positiveInteger),
};

/**
 * A run as the two list procedures carry it.
 *
 * Start and result payloads stay off this shape: both lists poll (the editor
 * every two seconds while the Runs tab is open), and neither paints them. They
 * ride `getExecutionLogs` instead, which is fetched for one open run.
 */
const workflowExecutionFields = {
  id: idSchema,
  workflowId: idSchema,
  status: workflowExecutionStatusSchema,
  startSource: Schema.NullOr(Schema.Literals(WORKFLOW_EXECUTION_START_SOURCES)),
  runMode: workflowRunModeSchema,
  startEventName: Schema.NullOr(Schema.String),
  entityValue: Schema.NullOr(Schema.String),
  /**
   * The kind of version this run pinned. `draft_snapshot` means the run used the
   * graph on the canvas instead of the published graph. Run history reads this
   * to label the run as a draft run.
   */
  versionKind: workflowVersionKindSchema,
  /**
   * The pinned version's number, which run history renders as "v7". Null for a
   * draft snapshot, because a snapshot carries no number. The shape matches
   * `publishedVersion` above, so a number no version can carry is refused at the
   * boundary instead of reaching a label as "vNaN".
   */
  versionNumber: Schema.NullOr(
    Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  /**
   * The slot a scheduled run fired for, which can be earlier than `startedAt`
   * when no worker ran at the slot. Null for a run no schedule started.
   */
  scheduledFor: Schema.NullOr(isoTimestampString()),
  /**
   * The schedule that started a scheduled run, in words, such as "Every
   * weekday at 9:00 AM (America/New_York)". Null for a run no schedule
   * started.
   */
  scheduleDescription: Schema.NullOr(Schema.String),
  waitingAt: Schema.NullOr(Schema.String),
  cancelledAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
  /** See `runListActivitySchema`. Null for every run that is not in progress. */
  activity: Schema.NullOr(runListActivitySchema),
};

const workflowExecutionSchema = Schema.Struct(workflowExecutionFields);

const executionLogSchema = Schema.Struct({
  id: idSchema,
  executionId: idSchema,
  nodeId: Schema.String,
  nodeName: Schema.String,
  nodeType: Schema.String,
  status: executionLogStatusSchema,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
  /**
   * How many times the database executor retried the node's steps before the
   * row closed. Zero while the row is open.
   */
  retries: nonNegativeInteger,
});

const executionSummarySchema = Schema.Struct({
  id: idSchema,
  workflowId: idSchema,
  /** The version this run pinned. `getVersionGraph` reads by this key. */
  workflowVersionId: idSchema,
  versionKind: workflowVersionKindSchema,
  versionNumber: workflowExecutionFields.versionNumber,
  status: workflowExecutionStatusSchema,
  startSource: workflowExecutionFields.startSource,
  runMode: workflowExecutionFields.runMode,
  startEventName: workflowExecutionFields.startEventName,
  entityValue: workflowExecutionFields.entityValue,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  scheduledFor: workflowExecutionFields.scheduledFor,
  scheduleDescription: workflowExecutionFields.scheduleDescription,
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
});

/**
 * One wait a run is parked on, as the Runs view reads it.
 *
 * The token is here because the Runs view's Resume affordance is what an operator
 * uses when the Event a run parked on will never arrive. It is a session-gated
 * read of a row this operator can already see.
 */
const executionWaitSchema = Schema.Struct({
  id: idSchema,
  nodeId: Schema.String,
  nodeName: Schema.String,
  resumeToken: Schema.NullOr(Schema.String),
  subscribedEvents: listOf(Schema.String),
  waitUntil: Schema.NullOr(Schema.String),
});

/**
 * Where the database executor holds an in-progress run: what a person reads
 * to learn why the run has not moved and when it will move next.
 *
 * `state` is `queued` (due at `wakeAt`), `leased` (a worker, `workerId`, is
 * running it until `leaseExpiresAt` unless it renews its lease, and
 * `runningStepId` is the step its last renewal recorded), or `waiting`
 * (asleep on its parks until `wakeAt`). `attempt` counts failures of the run
 * outside any step. `failingSteps` are the steps that failed and will run
 * again, most failures first, each with its node (null for a step of no
 * node) and, while the run waits out a retry, `nextTryAt`, the time the run
 * tries every failing step again; it is null while a worker holds the run or
 * the run is due. A step or the run body gets `retryLimit` retries.
 * `activity` is the server's decision about the run, null for a run queued
 * with no failure and not yet due. See `executorReadingFields` for
 * `observedAt` and `overdueAfterMs`.
 */
const executorStateSchema = Schema.Struct({
  ...executorReadingFields,
  activity: Schema.NullOr(scheduleActivitySchema),
  state: Schema.Literals(EXECUTION_SCHEDULE_STATES),
  wakeAt: executorInstant,
  attempt: nonNegativeInteger,
  retryLimit: positiveInteger,
  runningStepId: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(executorInstant),
  workerId: Schema.NullOr(Schema.String),
  failingSteps: listOf(
    Schema.Struct({
      nodeId: Schema.NullOr(Schema.String),
      failures: positiveInteger,
      error: Schema.String,
      nextTryAt: Schema.NullOr(executorInstant),
    })
  ),
});

/** See `executorStateSchema`. */
export type ExecutorStateView = (typeof executorStateSchema)["Type"];

/** The authoritative Entity Eligibility boundary stored on an exited run. */
const executionExitSchema = Schema.Struct({
  reason: Schema.Literals(ENTITY_ELIGIBILITY_REASONS),
  entityType: Schema.String,
  nodeId: Schema.String,
  checkedAt: Schema.String,
});

/**
 * One Refused Start: an audit row with no Execution behind it. The audit row
 * carries metadata too, and it stays server-side: this crosses on a two-second
 * poll, and the message already names the reason and the Event.
 */
const refusedStartSchema = Schema.Struct({
  id: idSchema,
  message: Schema.String,
  createdAt: Schema.String,
});

const executionEventSchema = Schema.Struct({
  id: idSchema,
  workflowId: idSchema,
  executionId: Schema.NullOr(Schema.String),
  eventType: Schema.String,
  message: Schema.String,
  metadata: Schema.Unknown,
  createdAt: Schema.String,
});

const ignoredReasonSchema = Schema.Literals(WORKFLOW_EXECUTION_IGNORED_REASONS);

/**
 * The two shapes a manual run answers with: it started a run, or it did not and
 * says why.
 */
const workflowExecutionRunningSchema = Schema.Struct({
  status: Schema.Literal("running"),
  executionId: Schema.String,
  runMode: workflowRunModeSchema,
  supersededExecutions: Schema.optionalKey(Schema.Finite),
});

// A paused workflow gets a run row saying it declined, so the runs list still
// shows the decision; a first-wins refusal has no run of its own, which is why
// the id is optional on this arm.
const workflowExecuteResponseSchema = Schema.Union([
  workflowExecutionRunningSchema,
  Schema.Struct({
    status: Schema.Literal("ignored"),
    runMode: workflowRunModeSchema,
    reason: ignoredReasonSchema,
    executionId: Schema.optionalKey(Schema.String),
  }),
]);

const workflowExecutionStatusFilterSchema = Schema.Literals(
  WORKFLOW_EXECUTION_STATUSES
);

const workflowGlobalExecutionSchema = Schema.Struct({
  ...workflowExecutionFields,
  workflowName: Schema.String,
  workflowIsPaused: Schema.Boolean,
});

const workflowGlobalExecutionsCursorSchema = Schema.Struct({
  startedAt: Schema.String,
  id: idSchema,
});

const workflowBulkActionSchema = Schema.Literals(["pause", "resume", "delete"]);

const workflowBulkLifecycleResultSchema = Schema.Struct({
  summary: Schema.Struct({
    requested: Schema.Finite,
    succeeded: Schema.Finite,
    failed: Schema.Finite,
  }),
  results: listOf(
    Schema.Struct({
      workflowId: idSchema,
      action: workflowBulkActionSchema,
      ok: Schema.Boolean,
      deleted: Schema.optionalKey(Schema.Boolean),
      error: Schema.optionalKey(Schema.String),
    })
  ),
});

const draftRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
);

const workflowDraftRevisionSchema = Schema.Struct({
  workflowId: idSchema,
  draftRevision: draftRevisionSchema,
});

export const workflowContract = {
  getAll: route("GET", "/workflows", WfGraphOperations.workflowGetAll)
    .input(noInput)
    .output(contractSchema(listOf(workflowSummarySchema))),
  subscribeList: route(
    "GET",
    "/workflows/list-subscription",
    WfGraphOperations.workflowSubscribeList
  )
    .input(noInput)
    .output(asyncIteratorObject(contractSchema(listOf(workflowSummarySchema)))),
  getById: route(
    "GET",
    "/workflows/{workflowId}",
    WfGraphOperations.workflowGetById
  )
    .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
    .output(workflowApiPayload),
  subscribeDraft: route(
    "GET",
    "/workflows/{workflowId}/draft-subscription",
    WfGraphOperations.workflowSubscribeDraft
  )
    .input(
      contractSchema(
        Schema.Struct({
          workflowId: idSchema,
          afterDraftRevision: Schema.Finite.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(0)
          ),
        })
      )
    )
    .output(asyncIteratorObject(contractSchema(workflowDraftRevisionSchema))),
  create: route("POST", "/workflows/create", WfGraphOperations.workflowCreate)
    .input(
      contractSchema(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optionalKey(Schema.String),
          graph: serializedWorkflowGraphSchema,
        })
      )
    )
    .output(workflowApiPayload),
  update: route(
    "PATCH",
    "/workflows/{workflowId}",
    WfGraphOperations.workflowUpdate
  )
    .input(
      contractSchema(
        Schema.Struct({
          workflowId: idSchema,
          name: Schema.optionalKey(Schema.String),
          description: Schema.optionalKey(Schema.String),
          graph: Schema.optionalKey(serializedWorkflowGraphSchema),
          expectedDraftRevision: Schema.optionalKey(
            Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))
          ),
          mode: Schema.optionalKey(workflowRunModeSchema),
        })
      )
    )
    .output(workflowApiPayload),
  delete: route(
    "DELETE",
    "/workflows/{workflowId}",
    WfGraphOperations.workflowDelete
  )
    .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
    .output(deleted),
  duplicate: route(
    "POST",
    "/workflows/{workflowId}/duplicate",
    WfGraphOperations.workflowDuplicate
  )
    .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
    .output(workflowApiPayload),
  /**
   * Mint the next immutable version from the graph the editor is showing and
   * point starts at it. Draft saves alone never start runs; the client sends
   * the canvas graph so an unsaved edit is what gets published.
   */
  publish: route(
    "POST",
    "/workflows/{workflowId}/publish",
    WfGraphOperations.workflowPublish
  )
    .input(contractSchema(workflowPublishInputSchema))
    .output(workflowPublishPayload),
  getVersionHistory: route(
    "GET",
    "/workflows/{workflowId}/versions",
    WfGraphOperations.workflowGetVersionHistory
  )
    .input(workflowVersionHistoryInput)
    .output(workflowVersionHistoryPayload),
  getVersionUsage: route(
    "GET",
    "/workflows/{workflowId}/versions/usage",
    WfGraphOperations.workflowGetVersionUsage
  )
    .input(workflowVersionUsageInput)
    .output(workflowVersionUsagePayload),
  /**
   * Classify every in-flight run of the workflow against another published
   * version. The report is a read: it names the runs that version can take
   * over, and the reason each of the rest stays where it is.
   */
  previewMigration: route(
    "POST",
    "/workflows/{workflowId}/migration/preview",
    WfGraphOperations.workflowPreviewMigration
  )
    .input(workflowMigrationPreviewInput)
    .output(workflowMigrationPreviewPayload),
  /**
   * Move the named parked runs onto the target published version. Each run is
   * classified again before it moves, so a run that woke since the preview is
   * refused rather than migrated.
   */
  migrateExecutions: route(
    "POST",
    "/workflows/{workflowId}/migration",
    WfGraphOperations.workflowMigrateExecutions
  )
    .input(workflowMigrationInput)
    .output(workflowMigrationPayload),
  compareVersion: route(
    "POST",
    "/workflows/{workflowId}/versions/compare",
    WfGraphOperations.workflowCompareVersion
  )
    .input(workflowComparisonInput)
    .output(workflowComparisonPayload),
  restoreVersion: route(
    "POST",
    "/workflows/{workflowId}/versions/{versionId}/restore",
    WfGraphOperations.workflowRestoreVersion
  )
    .input(workflowRestoreVersionInput)
    .output(workflowApiPayload),
  getCurrent: route(
    "GET",
    "/workflows/current",
    WfGraphOperations.workflowGetCurrent
  )
    .input(noInput)
    .output(workflowApiPayload),
  saveCurrent: route(
    "POST",
    "/workflows/current",
    WfGraphOperations.workflowSaveCurrent
  )
    .input(
      contractSchema(
        Schema.Struct({
          graph: serializedWorkflowGraphSchema,
          expectedDraftRevision: Schema.optionalKey(
            Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))
          ),
        })
      )
    )
    .output(workflowApiPayload),
  execute: route(
    "POST",
    "/workflow/{workflowId}/execute",
    WfGraphOperations.workflowExecute
  )
    .input(
      contractSchema(
        Schema.Struct({
          workflowId: idSchema,
          // The trigger payload arrives as a JSON request body and leaves again
          // as JSON: Inngest stringifies it onto the event, and the engine
          // stores it in the JSONB `workflow_executions.input` column. The
          // schema names that, so everything downstream reads `JsonObject`.
          input: Schema.optionalKey(jsonObjectSchema),
          /**
           * Which Start Event this run stands in for. The engine routes an
           * Event Split on it, so a run that names none takes no branch out of
           * one. Absent is the plain manual start.
           */
          eventName: Schema.optionalKey(NonEmptyTrimmedString),
          /**
           * Which graph to run: the published version, or the draft on the
           * canvas. Absent selects the published version and runs in the
           * workflow's Published mode, which is the path every Event start
           * takes. `draft` runs the canvas graph, freezes it into a snapshot
           * version the run pins to, and always records `runMode: "test"`
           * whatever the workflow's Published mode says.
           */
          graph: Schema.optionalKey(Schema.Literals(["published", "draft"])),
          /**
           * What the caller was shown when it offered this run. A published
           * run carries the version id and the Published mode the run dialog
           * displayed, and the server refuses the run when either has moved
           * since. Without it a dialog left open through a publish or a mode
           * change starts a run the person did not ask for. A draft run
           * carries none, because the canvas is the graph the run reads.
           */
          expected: Schema.optionalKey(
            Schema.Struct({
              versionId: idSchema,
              mode: workflowRunModeSchema,
            })
          ),
        })
      )
    )
    .output(contractSchema(workflowExecuteResponseSchema)),
  getExecutions: route(
    "GET",
    "/workflows/{workflowId}/executions",
    WfGraphOperations.workflowGetExecutions
  )
    .input(
      contractSchema(
        Schema.Struct({
          workflowId: idSchema,
          /**
           * Superseded runs are left out by default: a newest-wins workflow
           * displaces one on every reschedule, and those rows would crowd the
           * panel. `supersededCount` below is what the toggle asking for them is
           * labelled with, and it is answered either way.
           */
          includeSuperseded: Schema.optionalKey(Schema.Boolean),
        })
      )
    )
    .output(
      contractSchema(
        Schema.Struct({
          items: listOf(workflowExecutionSchema),
          /** Read each row's `activity` against these. See `executorReadingFields`. */
          ...executorReadingFields,
          /** See `runRetentionFields`. */
          ...runRetentionFields,
          /**
           * How many of the workflow's runs newer starts displaced, counted
           * up to one past `SUPERSEDED_COUNT_LIMIT`.
           */
          supersededCount: Schema.Finite,
          /**
           * Up to 50 recent starts that opened no run. Concurrency, a missing
           * Entity Value, workflow rules, or a Start Filter can refuse a start.
           * These rows ride with the runs because the panel polls this response.
           */
          refusedStarts: listOf(refusedStartSchema),
          /**
           * Up to 50 recent Cancel Events that reached no run. Missing Entity
           * Values and declined or unevaluable Cancel Filters produce these
           * rows. This category has a limit independent of Refused Starts.
           */
          cancelNotDelivered: listOf(refusedStartSchema),
        })
      )
    ),
  getExecutionsGlobal: route(
    "GET",
    "/workflows/executions",
    WfGraphOperations.workflowGetExecutionsGlobal
  )
    .input(
      contractSchema(
        Schema.Struct({
          workflowIds: Schema.optionalKey(listOf(idSchema)),
          statuses: Schema.optionalKey(
            listOf(workflowExecutionStatusFilterSchema)
          ),
          limit: Schema.optionalKey(
            Schema.Finite.check(
              Schema.isInt(),
              Schema.isBetween({ minimum: 1, maximum: 500 })
            )
          ),
          cursor: Schema.optionalKey(workflowGlobalExecutionsCursorSchema),
        })
      )
    )
    .output(
      contractSchema(
        Schema.Struct({
          items: listOf(workflowGlobalExecutionSchema),
          /** Read each row's `activity` against these. See `executorReadingFields`. */
          ...executorReadingFields,
          /** See `runRetentionFields`. */
          ...runRetentionFields,
          nextCursor: Schema.NullOr(workflowGlobalExecutionsCursorSchema),
        })
      )
    ),
  bulkLifecycle: route(
    "POST",
    "/workflows/bulk-lifecycle",
    WfGraphOperations.workflowBulkLifecycle
  )
    .input(
      contractSchema(
        Schema.Struct({
          workflowIds: listOf(idSchema).check(Schema.isMinLength(1)),
          action: workflowBulkActionSchema,
        })
      )
    )
    .output(contractSchema(workflowBulkLifecycleResultSchema)),
  deleteExecutions: route(
    "DELETE",
    "/workflows/{workflowId}/executions",
    WfGraphOperations.workflowDeleteExecutions
  )
    .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
    .output(
      contractSchema(
        Schema.Struct({
          success: Schema.Literal(true),
          deletedCount: Schema.Finite,
        })
      )
    ),
  getExecutionLogs: route(
    "GET",
    "/workflows/executions/{executionId}/logs",
    WfGraphOperations.workflowGetExecutionLogs
  )
    .input(contractSchema(Schema.Struct({ executionId: idSchema })))
    .output(
      contractSchema(
        Schema.Struct({
          execution: executionSummarySchema,
          logs: listOf(executionLogSchema),
          /**
           * How many retries the database executor gives a step before the
           * step fails its node, which a log's `retries` counts against: a
           * node that spent them finished on try `retryLimit + 1`.
           */
          retryLimit: positiveInteger,
          waits: listOf(executionWaitSchema),
          exit: Schema.NullOr(executionExitSchema),
          /**
           * See `executorStateSchema`. Null once the run has ended, when
           * the executor no longer holds it.
           */
          schedule: Schema.NullOr(executorStateSchema),
        })
      )
    ),
  /**
   * The pinned graph of one published version, on its own procedure rather
   * than riding the polled logs payload: the graph is immutable once minted,
   * so a client fetches it once per version id and caches the answer forever
   * (ADR-0012, "Readers load the version's graph").
   */
  getVersionGraph: route(
    "GET",
    "/workflows/versions/{versionId}/graph",
    WfGraphOperations.workflowGetVersionGraph
  )
    .input(contractSchema(Schema.Struct({ versionId: idSchema })))
    .output(
      contractSchema(Schema.Struct({ graph: serializedWorkflowGraphSchema }))
    ),
  resumeWait: route(
    "POST",
    "/workflows/waits/{token}/resume-from-panel",
    WfGraphOperations.workflowResumeWait
  )
    .input(
      contractSchema(
        Schema.Struct({
          token: idSchema,
          payload: Schema.optionalKey(jsonObjectSchema),
        })
      )
    )
    .output(
      contractSchema(
        Schema.Struct({
          success: Schema.Literal(true),
          status: Schema.Literal("resumed"),
          executionId: idSchema,
        })
      )
    ),
  getExecutionEvents: route(
    "GET",
    "/workflows/executions/{executionId}/events",
    WfGraphOperations.workflowGetExecutionEvents
  )
    .input(contractSchema(Schema.Struct({ executionId: idSchema })))
    .output(
      contractSchema(Schema.Struct({ events: listOf(executionEventSchema) }))
    ),
  cancelExecution: route(
    "POST",
    "/workflows/executions/{executionId}/cancel",
    WfGraphOperations.workflowCancelExecution
  )
    .input(contractSchema(Schema.Struct({ executionId: idSchema })))
    .output(
      contractSchema(
        Schema.Struct({
          success: Schema.Literal(true),
          status: Schema.Literal("canceled"),
          cancelledWaitStates: Schema.Finite,
        })
      )
    ),
  getExecutionStatus: route(
    "GET",
    "/workflows/executions/{executionId}/status",
    WfGraphOperations.workflowGetExecutionStatus
  )
    .input(contractSchema(Schema.Struct({ executionId: idSchema })))
    .output(
      contractSchema(
        Schema.Struct({
          status: workflowExecutionStatusSchema,
          nodeStatuses: listOf(
            Schema.Struct({
              nodeId: Schema.String,
              status: executionLogStatusSchema,
            })
          ),
          /**
           * The nodes holding an open wait, which a node status alone reads
           * as running. The editor shows each of them as Waiting while the
           * run is in progress.
           */
          openWaitNodeIds: listOf(Schema.String),
          /**
           * The nodes with a step that failed and will run again, which the
           * editor shows as retrying while the run is in progress.
           */
          retryingNodeIds: listOf(Schema.String),
        })
      )
    ),
};
