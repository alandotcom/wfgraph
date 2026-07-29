import { oc } from "@orpc/contract";
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
import { WORKFLOW_EXECUTION_IGNORED_REASONS } from "#src/workflow/execution-contracts";
import { serializedWorkflowGraphSchema } from "#src/workflow/schemas";

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

const integrationTypeSchema = Schema.Literals([
  "acuity",
  "clerk",
  "database",
  "linear",
  "resend",
  "slack",
  "twilio",
]);

const integrationConfigSchema = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(Schema.String)
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
// invent a value. It used to be optional throughout, which pushed a `?? ""` into
// every consumer — including two that fed the result straight to a router as a
// workflow id, where the empty string resolves to a route that redirects away.
const workflowApiPayloadSchema = Schema.Struct({
  id: idSchema,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  graph: serializedWorkflowGraphSchema,
  isPaused: Schema.Boolean,
  mode: Schema.Literals(["live", "test"]),
  visibility: Schema.Literals(["private", "public"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Absent on a payload the viewer did not author. */
  isOwner: Schema.optionalKey(Schema.Boolean),
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

const workflowRunModeSchema = Schema.Literals(["live", "test"]);

const workflowExecutionStatusSchema = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "success",
  "error",
  "cancelled",
]);

const workflowExecutionFields = {
  id: idSchema,
  workflowId: idSchema,
  status: workflowExecutionStatusSchema,
  triggerType: Schema.NullOr(Schema.Literals(["manual", "webhook", "event"])),
  runMode: workflowRunModeSchema,
  triggerEventType: Schema.NullOr(Schema.String),
  correlationKey: Schema.NullOr(Schema.String),
  workflowRunId: Schema.NullOr(Schema.String),
  input: Schema.Unknown,
  output: Schema.Unknown,
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
  status: Schema.Literals(["pending", "running", "success", "error"]),
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
  status: Schema.String,
  input: Schema.Unknown,
  output: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.String),
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
 * The four shapes an execute or webhook call answers with.
 *
 * Each stays open, as the Zod originals did: the engine adds counters to a
 * response as it learns them, and a client that has not been rebuilt should
 * read the fields it knows rather than fail on the ones it does not.
 */
const workflowExecutionRunningSchema = Schema.StructWithRest(
  Schema.Struct({
    status: Schema.Literal("running"),
    executionId: Schema.String,
    runId: Schema.optionalKey(Schema.String),
    runMode: workflowRunModeSchema,
    cancelledExecutions: Schema.optionalKey(Schema.Finite),
    cancelledWaits: Schema.optionalKey(Schema.Finite),
    failedExecutions: Schema.optionalKey(listOf(Schema.String)),
  }),
  unknownRest
);

const workflowExecutionCancelledFields = {
  status: Schema.Literal("cancelled"),
  runMode: workflowRunModeSchema,
  cancelledExecutions: Schema.Finite,
  cancelledWaits: Schema.Finite,
  failedExecutions: Schema.optionalKey(listOf(Schema.String)),
};

const workflowExecutionCancelledSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowExecutionCancelledFields,
    executionId: Schema.optionalKey(Schema.String),
  }),
  unknownRest
);

const workflowExecutionIgnoredFields = {
  status: Schema.Literal("ignored"),
  runMode: workflowRunModeSchema,
  reason: ignoredReasonSchema,
};

const workflowExecutionIgnoredSchema = Schema.StructWithRest(
  Schema.Struct({
    ...workflowExecutionIgnoredFields,
    executionId: Schema.optionalKey(Schema.String),
  }),
  unknownRest
);

const workflowExecutionResumedSchema = Schema.StructWithRest(
  Schema.Struct({
    status: Schema.Literal("resumed"),
    resumedCount: Schema.Finite,
    runMode: workflowRunModeSchema,
  }),
  unknownRest
);

// An execute call has always started, cancelled or ignored a specific
// execution, so the two arms that carry an optional id elsewhere require it
// here.
const workflowExecuteResponseSchema = Schema.Union([
  workflowExecutionRunningSchema,
  Schema.StructWithRest(
    Schema.Struct({
      ...workflowExecutionCancelledFields,
      executionId: Schema.String,
    }),
    unknownRest
  ),
  Schema.StructWithRest(
    Schema.Struct({
      ...workflowExecutionIgnoredFields,
      executionId: Schema.String,
    }),
    unknownRest
  ),
]);

const workflowWebhookResponseSchema = Schema.Union([
  workflowExecutionRunningSchema,
  workflowExecutionCancelledSchema,
  workflowExecutionIgnoredSchema,
  workflowExecutionResumedSchema,
]);

const workflowExecutionStatusFilterSchema = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "success",
  "error",
  "cancelled",
]);

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

export const rpcContract = {
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
            config: integrationConfigSchema,
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
            config: Schema.optionalKey(integrationConfigSchema),
          })
        )
      )
      .output(integrationWithConfig),
    delete: route("DELETE", "/integrations/{integrationId}")
      .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
      .output(deleted),
    testConnection: route("POST", "/integrations/{integrationId}/test")
      .input(contractSchema(Schema.Struct({ integrationId: idSchema })))
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
      .output(contractSchema(listOf(workflowApiPayloadSchema))),
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
          })
        )
      )
      .output(contractSchema(workflowExecuteResponseSchema)),
    triggerWebhook: route("POST", "/workflows/{workflowId}/webhook")
      .input(
        contractSchema(
          Schema.Struct({
            workflowId: idSchema,
            input: Schema.optionalKey(jsonObjectSchema),
          })
        )
      )
      .output(contractSchema(workflowWebhookResponseSchema)),
    getExecutions: route("GET", "/workflows/{workflowId}/executions")
      .input(contractSchema(Schema.Struct({ workflowId: idSchema })))
      .output(contractSchema(listOf(workflowExecutionSchema))),
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
            status: Schema.Literal("cancelled"),
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
