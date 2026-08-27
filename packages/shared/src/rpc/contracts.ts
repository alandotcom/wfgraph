import { eventIterator, oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { Schema } from "effect";
import { jsonObjectSchema } from "#src/types/json";
import {
  listOf,
  NonEmptyTrimmedString,
  rejectUnknownKeys,
  toStandardSchema,
  unknownRest,
} from "#src/types/schema";
import {
  WORKFLOW_EXECUTION_IGNORED_REASONS,
  WORKFLOW_EXECUTION_START_SOURCES,
  WORKFLOW_EXECUTION_STATUSES,
} from "#src/lifecycle/execution-contracts";
import { serializedWorkflowGraphSchema } from "#src/graph/schemas";
import { isoTimestampString } from "#src/types/timestamp";
import { OAUTH_GRANT_CONFIG_KEY } from "#src/types/integration";
import {
  agentMessageSchema,
  agentStreamPartSchema,
} from "#src/rpc/agent-stream";
import {
  workflowComparisonInputSchema,
  workflowComparisonPayloadSchema,
  workflowPublishInputSchema,
  workflowRestoreVersionInputSchema,
  workflowVersionHistoryInputSchema,
  workflowVersionHistoryPayloadSchema,
} from "#src/graph/publication-contracts";

/**
 * Declares a procedure's REST shape. Routing metadata moved off the contract
 * builder in oRPC 2, and this helper is the single line coupling the contracts
 * to @orpc/openapi.
 */
function route(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: `/${string}`
) {
  return oc.meta(openapi({ method, path }));
}

/**
 * Hands a schema to oRPC as a Standard Schema, closed to keys it did not name.
 *
 * `@orpc/experimental-effect` exports a `toStandardSchema` of its own and this
 * is not it. That one takes no parse options, and parse options are the only
 * way an Effect schema can be strict about unknown keys: oRPC calls
 * `~standard.validate(payload)` with nothing else to say, so anything the
 * schema wants to be true of that call has to be closed over before it gets
 * there. The two are otherwise interchangeable -- Effect assigns `~standard`
 * onto the schema and hands the same object back, so the schema oRPC holds is
 * still an Effect schema either way, which is what
 * `EffectSchemaToJsonSchemaConverter` looks for when it builds the OpenAPI
 * document. The one thing oRPC's version adds, carrying meta plugins across, is
 * a copy onto the object it was read from.
 *
 * Effect's bridge is first-call-wins: a schema that already carries a
 * `validate` keeps it, options and all. So every schema crosses here exactly
 * once. A shape more than one procedure names is bridged once at module scope
 * and the binding is what the procedures hand to oRPC -- `noInput`, `deleted`,
 * and the three beside `workflowApiPayload` below. `toStandardSchema` throws on
 * a second crossing that carries options rather than dropping them, so this is
 * a rule the file cannot quietly break.
 */
function contractSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
) {
  return toStandardSchema(schema, rejectUnknownKeys);
}

/**
 * A procedure that takes no arguments still declares the empty object.
 *
 * Open rather than closed, and not for taste: `Schema.Struct({})` describes
 * TypeScript's `object`, so its JSON Schema is `anyOf: [object, array]` and
 * oRPC refuses it for a GET, whose inputs are query parameters and must be an
 * object. Naming the rest gives the plain `{"type":"object"}` the generator
 * wants. It also lets a stray query parameter through instead of answering 400,
 * which is what a GET taking no arguments should do with a cache-buster.
 */
const noInput = contractSchema(
  Schema.StructWithRest(Schema.Struct({}), unknownRest)
);

const deleted = contractSchema(
  Schema.Struct({ success: Schema.Literal(true) })
);

const idSchema = NonEmptyTrimmedString;

/**
 * Which integration a connection is for.
 *
 * A plain identifier rather than a closed list: the set of integrations is
 * whatever a host passed to `createWfGraphApp`, so the server refuses a type its
 * assembled catalog does not hold and says which types it does. A literal list
 * here could only be a second, staler copy of that answer.
 */
const integrationTypeSchema = NonEmptyTrimmedString;

const integrationConfigSchema = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(Schema.String)
);

const manualIntegrationConfigSchema = integrationConfigSchema.check(
  Schema.makeFilter((config) => !(OAUTH_GRANT_CONFIG_KEY in config), {
    expected: "an integration config without the reserved OAuth grant key",
  })
);

const apiKeyFields = {
  id: idSchema,
  name: Schema.NullOr(Schema.String),
  keyPrefix: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
};

const integrationFields = {
  id: idSchema,
  name: Schema.String,
  type: integrationTypeSchema,
  isManaged: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  configuredKeys: Schema.Array(Schema.String),
  oauth: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["connected", "reauthorization_required"]),
      connectedAt: isoTimestampString(),
      accountLabel: Schema.optionalKey(Schema.String),
      credentialKeys: Schema.Array(NonEmptyTrimmedString),
      /**
       * How much access the provider granted, in its own words, for the
       * connection dialog to show. Absent for a provider that never says, and
       * for a grant issued before this connection last authorized.
       */
      grantedAccessLabel: Schema.optionalKey(NonEmptyTrimmedString),
    })
  ),
};

const integrationSchema = Schema.Struct(integrationFields);

const integrationWithConfigSchema = Schema.Struct({
  ...integrationFields,
  config: integrationConfigSchema,
});

const integrationTestResultSchema = Schema.Struct({
  status: Schema.Literals(["success", "error"]),
  message: Schema.String,
});

// Everything here but `description` and `isOwner` comes from a non-null column
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
  /** Absent on a payload the viewer did not author. */
  isOwner: Schema.optionalKey(Schema.Boolean),
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
 * The three shapes more than one procedure answers with, bridged here rather
 * than at each `.output()`.
 *
 * `toStandardSchema` refuses a second crossing that carries parse options, and
 * these are the shapes that would otherwise ask for one. Binding the bridged
 * form is also what the schema means: one object, one set of decode options,
 * however many procedures hand it back.
 */
const integrationWithConfig = contractSchema(integrationWithConfigSchema);
const integrationTestResult = contractSchema(integrationTestResultSchema);
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
  /** The published version this run pinned; the key `getVersionGraph` reads by. */
  workflowVersionId: idSchema,
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

/**
 * The build agent's one procedure, and the only streaming contract in the repo.
 *
 * `eventIterator` is oRPC's async-iterator output: the handler is a generator
 * and `RPCLink` hands the browser an async iterable, so the chat panel reads a
 * turn as it is produced without a second transport beside the RPC client.
 *
 * The turn carries the whole conversation and the whole graph, because neither
 * is kept on the server. Nothing about a turn outlives the request that ran it.
 */
export const MAX_AGENT_MESSAGES = 100;
export const MAX_AGENT_MESSAGE_CHARS = 32_000;
export const MAX_AGENT_GRAPH_NODES = 500;
export const MAX_AGENT_GRAPH_EDGES = 2_000;
export const MAX_AGENT_REQUEST_CHARS = 1_000_000;

const boundedAgentMessageSchema = agentMessageSchema.check(
  Schema.makeFilter(
    (message) => message.content.length <= MAX_AGENT_MESSAGE_CHARS,
    { expected: `a message of at most ${MAX_AGENT_MESSAGE_CHARS} characters` }
  )
);

const boundedAgentGraphSchema = serializedWorkflowGraphSchema.check(
  Schema.makeFilter(
    (graph) =>
      graph.nodes.length <= MAX_AGENT_GRAPH_NODES &&
      graph.edges.length <= MAX_AGENT_GRAPH_EDGES,
    {
      expected: `a graph with at most ${MAX_AGENT_GRAPH_NODES} nodes and ${MAX_AGENT_GRAPH_EDGES} edges`,
    }
  )
);

export const agentChatInputSchema = Schema.Struct({
  workflowId: idSchema,
  messages: listOf(boundedAgentMessageSchema).check(
    Schema.isMaxLength(MAX_AGENT_MESSAGES)
  ),
  graph: boundedAgentGraphSchema,
}).check(
  Schema.makeFilter(
    (input) => JSON.stringify(input).length <= MAX_AGENT_REQUEST_CHARS,
    {
      expected: `an agent request of at most ${MAX_AGENT_REQUEST_CHARS} characters`,
    }
  )
);

const agentChatInput = contractSchema(agentChatInputSchema);

export const rpcContract = {
  agent: {
    chat: route("POST", "/agent/chat")
      .input(agentChatInput)
      .output(eventIterator(contractSchema(agentStreamPartSchema))),
  },
  apiKey: {
    getAll: route("GET", "/api-keys")
      .input(noInput)
      .output(contractSchema(listOf(Schema.Struct(apiKeyFields)))),
    create: route("POST", "/api-keys")
      .input(
        contractSchema(
          Schema.Struct({
            name: Schema.optionalKey(Schema.NullOr(Schema.String)),
          })
        )
      )
      .output(
        contractSchema(Schema.Struct({ ...apiKeyFields, key: Schema.String }))
      ),
    delete: route("DELETE", "/api-keys/{keyId}")
      .input(contractSchema(Schema.Struct({ keyId: idSchema })))
      .output(deleted),
  },
  integration: {
    getAll: route("GET", "/integrations")
      .input(
        contractSchema(
          Schema.Struct({
            type: Schema.optionalKey(integrationTypeSchema),
          })
        )
      )
      .output(contractSchema(listOf(integrationSchema))),
    get: route("GET", "/integrations/{integrationId}")
      .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
      .output(integrationWithConfig),
    create: route("POST", "/integrations")
      .input(
        contractSchema(
          Schema.Struct({
            name: Schema.String,
            type: integrationTypeSchema,
            config: manualIntegrationConfigSchema,
          })
        )
      )
      .output(contractSchema(integrationSchema)),
    update: route("PUT", "/integrations/{integrationId}")
      .input(
        contractSchema(
          Schema.Struct({
            integrationId: idSchema,
            name: Schema.optionalKey(Schema.String),
            config: Schema.optionalKey(manualIntegrationConfigSchema),
          })
        )
      )
      .output(integrationWithConfig),
    delete: route("DELETE", "/integrations/{integrationId}")
      .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
      .output(deleted),
    disconnectOAuth: route("DELETE", "/integrations/{integrationId}/oauth")
      .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
      .output(deleted),
    testConnection: route("POST", "/integrations/{integrationId}/test")
      .input(
        contractSchema(
          Schema.Struct({
            integrationId: idSchema,
            config: Schema.optionalKey(manualIntegrationConfigSchema),
          })
        )
      )
      .output(integrationTestResult),
    testCredentials: route("POST", "/integrations/test")
      .input(
        contractSchema(
          Schema.Struct({
            type: integrationTypeSchema,
            config: integrationConfigSchema,
          })
        )
      )
      .output(integrationTestResult),
  },
  workflow: {
    getAll: route("GET", "/workflows")
      .input(noInput)
      .output(contractSchema(listOf(workflowSummarySchema))),
    getById: route("GET", "/workflows/{workflowId}")
      .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
      .output(workflowApiPayload),
    create: route("POST", "/workflows/create")
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
    update: route("PATCH", "/workflows/{workflowId}")
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
    delete: route("DELETE", "/workflows/{workflowId}")
      .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
      .output(deleted),
    duplicate: route("POST", "/workflows/{workflowId}/duplicate")
      .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
      .output(workflowApiPayload),
    /**
     * Mint the next immutable version from the graph the editor is showing and
     * point starts at it. Draft saves alone never start runs; the client sends
     * the canvas graph so an unsaved edit is what gets published.
     */
    publish: route("POST", "/workflows/{workflowId}/publish")
      .input(contractSchema(workflowPublishInputSchema))
      .output(workflowPublishPayload),
    getVersionHistory: route("GET", "/workflows/{workflowId}/versions")
      .input(workflowVersionHistoryInput)
      .output(workflowVersionHistoryPayload),
    compareVersion: route("POST", "/workflows/{workflowId}/versions/compare")
      .input(workflowComparisonInput)
      .output(workflowComparisonPayload),
    restoreVersion: route(
      "POST",
      "/workflows/{workflowId}/versions/{versionId}/restore"
    )
      .input(workflowRestoreVersionInput)
      .output(workflowApiPayload),
    getCurrent: route("GET", "/workflows/current")
      .input(noInput)
      .output(workflowApiPayload),
    saveCurrent: route("POST", "/workflows/current")
      .input(
        contractSchema(Schema.Struct({ graph: serializedWorkflowGraphSchema }))
      )
      .output(workflowApiPayload),
    execute: route("POST", "/workflow/{workflowId}/execute")
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
          })
        )
      )
      .output(contractSchema(workflowExecuteResponseSchema)),
    getExecutions: route("GET", "/workflows/{workflowId}/executions")
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
    getExecutionsGlobal: route("GET", "/workflows/executions")
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
    bulkLifecycle: route("POST", "/workflows/bulk-lifecycle")
      .input(
        contractSchema(
          Schema.Struct({
            workflowIds: listOf(idSchema).check(Schema.isMinLength(1)),
            action: workflowBulkActionSchema,
          })
        )
      )
      .output(contractSchema(workflowBulkLifecycleResultSchema)),
    deleteExecutions: route("DELETE", "/workflows/{workflowId}/executions")
      .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
      .output(
        contractSchema(
          Schema.Struct({
            success: Schema.Literal(true),
            deletedCount: Schema.Finite,
          })
        )
      ),
    getExecutionLogs: route("GET", "/workflows/executions/{executionId}/logs")
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
    getVersionGraph: route("GET", "/workflows/versions/{versionId}/graph")
      .input(contractSchema(Schema.Struct({ versionId: idSchema })))
      .output(
        contractSchema(Schema.Struct({ graph: serializedWorkflowGraphSchema }))
      ),
    resumeWait: route("POST", "/workflows/waits/{token}/resume-from-panel")
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
      "/workflows/executions/{executionId}/events"
    )
      .input(contractSchema(Schema.Struct({ executionId: idSchema })))
      .output(
        contractSchema(Schema.Struct({ events: listOf(executionEventSchema) }))
      ),
    cancelExecution: route("POST", "/workflows/executions/{executionId}/cancel")
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
      "/workflows/executions/{executionId}/status"
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
  },
};

export type RpcContract = typeof rpcContract;
