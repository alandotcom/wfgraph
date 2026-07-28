import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { z } from "zod";
import { jsonObjectSchema } from "#src/types/json";
import { WORKFLOW_EXECUTION_IGNORED_REASONS } from "#src/workflow/execution-contracts";
import { serializedWorkflowGraphSchema } from "#src/workflow/schemas";

/**
 * Declares a procedure's REST shape. Routing metadata moved off the contract
 * builder in oRPC 2, and this helper is the single line coupling the contracts
 * to @orpc/openapi; when ADR-0002 stage 4 changes the construction again, the
 * edit lands here instead of at every procedure.
 */
function route(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: `/${string}`
) {
  return oc.meta(openapi({ method, path }));
}

const idSchema = z.string().trim().min(1);

const integrationTypeSchema = z.enum([
  "acuity",
  "clerk",
  "database",
  "linear",
  "resend",
  "slack",
  "twilio",
]);

const integrationConfigSchema = z.record(z.string(), z.string().optional());

const apiKeySchema = z.object({
  id: idSchema,
  name: z.string().nullable(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const apiKeyCreatedSchema = apiKeySchema.extend({
  key: z.string(),
});

const integrationSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: integrationTypeSchema,
  isManaged: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const integrationWithConfigSchema = integrationSchema.extend({
  config: integrationConfigSchema,
});

const integrationTestResultSchema = z.object({
  status: z.enum(["success", "error"]),
  message: z.string(),
});

// Everything here but `description` and `isOwner` comes from a non-null column
// through the one mapper that builds this payload, so the client never has to
// invent a value. It used to be optional throughout, which pushed a `?? ""` into
// every consumer — including two that fed the result straight to a router as a
// workflow id, where the empty string resolves to a route that redirects away.
const workflowApiPayloadSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().optional(),
  graph: serializedWorkflowGraphSchema,
  isPaused: z.boolean(),
  mode: z.enum(["live", "test"]),
  visibility: z.enum(["private", "public"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Absent on a payload the viewer did not author. */
  isOwner: z.boolean().optional(),
});
const workflowRunModeSchema = z.enum(["live", "test"]);

const workflowExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "success",
  "error",
  "cancelled",
]);

const workflowExecutionSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  status: workflowExecutionStatusSchema,
  triggerType: z.enum(["manual", "webhook", "event"]).nullable(),
  runMode: workflowRunModeSchema,
  triggerEventType: z.string().nullable(),
  correlationKey: z.string().nullable(),
  workflowRunId: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  startedAt: z.string(),
  waitingAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  duration: z.string().nullable(),
});

const executionLogSchema = z.object({
  id: idSchema,
  executionId: idSchema,
  nodeId: z.string(),
  nodeName: z.string(),
  nodeType: z.string(),
  status: z.enum(["pending", "running", "success", "error"]),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  duration: z.string().nullable(),
});

const executionSummarySchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  status: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  duration: z.string().nullable(),
});

const executionEventSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  executionId: z.string().nullable(),
  eventType: z.string(),
  message: z.string(),
  metadata: z.unknown(),
  createdAt: z.string(),
});

const ignoredReasonSchema = z.enum(WORKFLOW_EXECUTION_IGNORED_REASONS);

const workflowExecutionRunningSchema = z
  .object({
    status: z.literal("running"),
    executionId: z.string(),
    runId: z.string().optional(),
    runMode: workflowRunModeSchema,
    cancelledExecutions: z.number().optional(),
    cancelledWaits: z.number().optional(),
    failedExecutions: z.array(z.string()).optional(),
  })
  .loose();

const workflowExecutionCancelledSchema = z
  .object({
    status: z.literal("cancelled"),
    executionId: z.string().optional(),
    runMode: workflowRunModeSchema,
    cancelledExecutions: z.number(),
    cancelledWaits: z.number(),
    failedExecutions: z.array(z.string()).optional(),
  })
  .loose();

const workflowExecutionIgnoredSchema = z
  .object({
    status: z.literal("ignored"),
    executionId: z.string().optional(),
    runMode: workflowRunModeSchema,
    reason: ignoredReasonSchema,
  })
  .loose();

const workflowExecutionResumedSchema = z
  .object({
    status: z.literal("resumed"),
    resumedCount: z.number(),
    runMode: workflowRunModeSchema,
  })
  .loose();

const workflowExecuteResponseSchema = z.discriminatedUnion("status", [
  workflowExecutionRunningSchema,
  workflowExecutionCancelledSchema.extend({
    executionId: z.string(),
  }),
  workflowExecutionIgnoredSchema.extend({
    executionId: z.string(),
    runMode: workflowRunModeSchema,
  }),
]);

const workflowWebhookResponseSchema = z.discriminatedUnion("status", [
  workflowExecutionRunningSchema,
  workflowExecutionCancelledSchema,
  workflowExecutionIgnoredSchema,
  workflowExecutionResumedSchema,
]);

const workflowExecutionStatusFilterSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "success",
  "error",
  "cancelled",
]);

const workflowGlobalExecutionSchema = workflowExecutionSchema.extend({
  workflowName: z.string(),
  workflowIsPaused: z.boolean(),
});

const workflowGlobalExecutionsCursorSchema = z.object({
  startedAt: z.string(),
  id: idSchema,
});

const workflowBulkActionSchema = z.enum(["pause", "resume", "delete"]);

const workflowBulkLifecycleResultSchema = z.object({
  summary: z.object({
    requested: z.number(),
    succeeded: z.number(),
    failed: z.number(),
  }),
  results: z.array(
    z.object({
      workflowId: idSchema,
      action: workflowBulkActionSchema,
      ok: z.boolean(),
      deleted: z.boolean().optional(),
      error: z.string().optional(),
    })
  ),
});

export const rpcContract = {
  apiKey: {
    getAll: route("GET", "/api-keys")
      .input(z.object({}))
      .output(z.array(apiKeySchema)),
    create: route("POST", "/api-keys")
      .input(
        z.object({
          name: z.string().nullable().optional(),
        })
      )
      .output(apiKeyCreatedSchema),
    delete: route("DELETE", "/api-keys/{keyId}")
      .input(
        z.object({
          keyId: idSchema,
        })
      )
      .output(z.object({ success: z.literal(true) })),
  },
  integration: {
    getAll: route("GET", "/integrations")
      .input(
        z.object({
          type: integrationTypeSchema.optional(),
        })
      )
      .output(z.array(integrationSchema)),
    get: route("GET", "/integrations/{integrationId}")
      .input(
        z.object({
          integrationId: idSchema,
        })
      )
      .output(integrationWithConfigSchema),
    create: route("POST", "/integrations")
      .input(
        z.object({
          name: z.string(),
          type: integrationTypeSchema,
          config: integrationConfigSchema,
        })
      )
      .output(integrationSchema),
    update: route("PUT", "/integrations/{integrationId}")
      .input(
        z.object({
          integrationId: idSchema,
          name: z.string().optional(),
          config: integrationConfigSchema.optional(),
        })
      )
      .output(integrationWithConfigSchema),
    delete: oc
      .meta(
        openapi({ method: "DELETE", path: "/integrations/{integrationId}" })
      )
      .input(
        z.object({
          integrationId: idSchema,
        })
      )
      .output(z.object({ success: z.literal(true) })),
    testConnection: oc
      .meta(
        openapi({ method: "POST", path: "/integrations/{integrationId}/test" })
      )
      .input(
        z.object({
          integrationId: idSchema,
        })
      )
      .output(integrationTestResultSchema),
    testCredentials: route("POST", "/integrations/test")
      .input(
        z.object({
          type: integrationTypeSchema,
          config: integrationConfigSchema,
        })
      )
      .output(integrationTestResultSchema),
  },
  workflow: {
    getAll: route("GET", "/workflows")
      .input(z.object({}))
      .output(z.array(workflowApiPayloadSchema)),
    getById: route("GET", "/workflows/{workflowId}")
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    create: route("POST", "/workflows/create")
      .input(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          graph: serializedWorkflowGraphSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    update: route("PATCH", "/workflows/{workflowId}")
      .input(
        z.object({
          workflowId: idSchema,
          name: z.string().optional(),
          description: z.string().optional(),
          graph: serializedWorkflowGraphSchema.optional(),
          mode: workflowRunModeSchema.optional(),
        })
      )
      .output(workflowApiPayloadSchema),
    delete: route("DELETE", "/workflows/{workflowId}")
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(z.object({ success: z.literal(true) })),
    duplicate: oc
      .meta(
        openapi({ method: "POST", path: "/workflows/{workflowId}/duplicate" })
      )
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    getCurrent: route("GET", "/workflows/current")
      .input(z.object({}))
      .output(workflowApiPayloadSchema),
    saveCurrent: route("POST", "/workflows/current")
      .input(
        z.object({
          graph: serializedWorkflowGraphSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    execute: route("POST", "/workflow/{workflowId}/execute")
      .input(
        z.object({
          workflowId: idSchema,
          // The trigger payload arrives as a JSON request body and leaves again
          // as JSON: Inngest stringifies it onto the event, and the engine
          // stores it in the JSONB `workflow_executions.input` column. The
          // schema names that, so everything downstream reads `JsonObject`.
          input: jsonObjectSchema.optional(),
        })
      )
      .output(workflowExecuteResponseSchema),
    triggerWebhook: oc
      .meta(
        openapi({ method: "POST", path: "/workflows/{workflowId}/webhook" })
      )
      .input(
        z.object({
          workflowId: idSchema,
          input: jsonObjectSchema.optional(),
        })
      )
      .output(workflowWebhookResponseSchema),
    getExecutions: oc
      .meta(
        openapi({ method: "GET", path: "/workflows/{workflowId}/executions" })
      )
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(z.array(workflowExecutionSchema)),
    getExecutionsGlobal: route("GET", "/workflows/executions")
      .input(
        z.object({
          workflowIds: z.array(idSchema).optional(),
          statuses: z.array(workflowExecutionStatusFilterSchema).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          cursor: workflowGlobalExecutionsCursorSchema.optional(),
        })
      )
      .output(
        z.object({
          items: z.array(workflowGlobalExecutionSchema),
          nextCursor: workflowGlobalExecutionsCursorSchema.nullable(),
        })
      ),
    bulkLifecycle: route("POST", "/workflows/bulk-lifecycle")
      .input(
        z.object({
          workflowIds: z.array(idSchema).min(1),
          action: workflowBulkActionSchema,
        })
      )
      .output(workflowBulkLifecycleResultSchema),
    deleteExecutions: oc
      .meta(
        openapi({
          method: "DELETE",
          path: "/workflows/{workflowId}/executions",
        })
      )
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(
        z.object({
          success: z.literal(true),
          deletedCount: z.number(),
        })
      ),
    getExecutionLogs: oc
      .meta(
        openapi({
          method: "GET",
          path: "/workflows/executions/{executionId}/logs",
        })
      )
      .input(
        z.object({
          executionId: idSchema,
        })
      )
      .output(
        z.object({
          execution: executionSummarySchema,
          logs: z.array(executionLogSchema),
        })
      ),
    getExecutionEvents: oc
      .meta(
        openapi({
          method: "GET",
          path: "/workflows/executions/{executionId}/events",
        })
      )
      .input(
        z.object({
          executionId: idSchema,
        })
      )
      .output(
        z.object({
          events: z.array(executionEventSchema),
        })
      ),
    cancelExecution: oc
      .meta(
        openapi({
          method: "POST",
          path: "/workflows/executions/{executionId}/cancel",
        })
      )
      .input(
        z.object({
          executionId: idSchema,
        })
      )
      .output(
        z.object({
          success: z.literal(true),
          status: z.literal("cancelled"),
          cancelledWaitStates: z.number(),
        })
      ),
    getExecutionStatus: oc
      .meta(
        openapi({
          method: "GET",
          path: "/workflows/executions/{executionId}/status",
        })
      )
      .input(
        z.object({
          executionId: idSchema,
        })
      )
      .output(
        z.object({
          status: z.string(),
          nodeStatuses: z.array(
            z.object({
              nodeId: z.string(),
              status: z.enum([
                "pending",
                "running",
                "success",
                "error",
                "cancelled",
              ]),
            })
          ),
        })
      ),
  },
};

export type RpcContract = typeof rpcContract;
