import { Schema } from "effect";
import { WfGraphOperations } from "#src/authorization/operations";
import {
  workflowComparisonInputSchema,
  workflowComparisonPayloadSchema,
  workflowPublishInputSchema,
  workflowRestoreVersionInputSchema,
  workflowVersionHistoryInputSchema,
  workflowVersionHistoryPayloadSchema,
} from "#src/graph/publication-contracts";
import { serializedWorkflowGraphSchema } from "#src/graph/schemas";
import { WORKFLOW_VERSION_KINDS } from "#src/graph/version-kinds";
import {
  WORKFLOW_EXECUTION_IGNORED_REASONS,
  WORKFLOW_EXECUTION_START_SOURCES,
  WORKFLOW_EXECUTION_STATUSES,
} from "#src/lifecycle/execution-contracts";
import { jsonObjectSchema } from "#src/types/json";
import { listOf, NonEmptyTrimmedString } from "#src/types/schema";
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
const workflowSummarySchema = Schema.Struct({
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
  workflowRunId: Schema.NullOr(Schema.String),
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
  waitingAt: Schema.NullOr(Schema.String),
  cancelledAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
};

const workflowExecutionSchema = Schema.Struct(workflowExecutionFields);

const executionLogSchema = Schema.Struct({
  id: idSchema,
  executionId: idSchema,
  nodeId: Schema.String,
  nodeName: Schema.String,
  nodeType: Schema.String,
  status: Schema.Literals([
    "pending",
    "running",
    "success",
    "error",
    "cancelled",
  ]),
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
});

const executionSummarySchema = Schema.Struct({
  id: idSchema,
  workflowId: idSchema,
  /** The version this run pinned. `getVersionGraph` reads by this key. */
  workflowVersionId: idSchema,
  versionKind: workflowVersionKindSchema,
  versionNumber: workflowExecutionFields.versionNumber,
  status: Schema.String,
  startSource: workflowExecutionFields.startSource,
  runMode: workflowExecutionFields.runMode,
  startEventName: workflowExecutionFields.startEventName,
  entityValue: workflowExecutionFields.entityValue,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
});

/**
 * One wait a run is parked on, as the runs panel reads it.
 *
 * The token is here because the panel's Resume affordance is what an operator
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
  runId: Schema.optionalKey(Schema.String),
  runMode: workflowRunModeSchema,
  supersededExecutions: Schema.optionalKey(Schema.Finite),
  failedToSupersede: Schema.optionalKey(listOf(Schema.String)),
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

export const workflowContract = {
  getAll: route("GET", "/workflows", WfGraphOperations.workflowGetAll)
    .input(noInput)
    .output(contractSchema(listOf(workflowSummarySchema))),
  getById: route(
    "GET",
    "/workflows/{workflowId}",
    WfGraphOperations.workflowGetById
  )
    .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
    .output(workflowApiPayload),
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
      contractSchema(Schema.Struct({ graph: serializedWorkflowGraphSchema }))
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
          supersededCount: Schema.Finite,
          /**
           * The starts that opened no run: first-wins Concurrency finding a run
           * for the entity already going, a payload carrying nothing at the
           * Correlation Path, or a manual start the rules do not allow. They ride
           * along here because the panel showing them polls with the runs.
           */
          refusedStarts: listOf(refusedStartSchema),
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
          waits: listOf(executionWaitSchema),
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
          status: Schema.String,
          nodeStatuses: listOf(
            Schema.Struct({
              nodeId: Schema.String,
              status: Schema.Literals([
                "pending",
                "running",
                "success",
                "error",
                "cancelled",
              ]),
            })
          ),
        })
      )
    ),
};
