import { oc } from "@orpc/contract";
import { z } from "zod";
import { jsonObjectSchema } from "@/types/json";
import { serializedWorkflowGraphSchema } from "@/workflow/schemas";

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

const ignoredReasonSchema = z.enum([
  "missing_event_type",
  "event_not_configured",
  "no_waiting_runs",
  "workflow_paused",
]);

const workflowExecutionRunningSchema = z
  .object({
    status: z.literal("running"),
    executionId: z.string(),
    runId: z.string().optional(),
    runMode: workflowRunModeSchema,
    cancelledExecutions: z.number().optional(),
    cancelledWaits: z.number().optional(),
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
    getAll: oc
      .route({ method: "GET", path: "/api-keys" })
      .input(z.object({}))
      .output(z.array(apiKeySchema)),
    create: oc
      .route({ method: "POST", path: "/api-keys" })
      .input(
        z.object({
          name: z.string().nullable().optional(),
        })
      )
      .output(apiKeyCreatedSchema),
    delete: oc
      .route({ method: "DELETE", path: "/api-keys/{keyId}" })
      .input(
        z.object({
          keyId: idSchema,
        })
      )
      .output(z.object({ success: z.literal(true) })),
  },
  integration: {
    getAll: oc
      .route({ method: "GET", path: "/integrations" })
      .input(
        z.object({
          type: integrationTypeSchema.optional(),
        })
      )
      .output(z.array(integrationSchema)),
    get: oc
      .route({ method: "GET", path: "/integrations/{integrationId}" })
      .input(
        z.object({
          integrationId: idSchema,
        })
      )
      .output(integrationWithConfigSchema),
    create: oc
      .route({ method: "POST", path: "/integrations" })
      .input(
        z.object({
          name: z.string(),
          type: integrationTypeSchema,
          config: integrationConfigSchema,
        })
      )
      .output(integrationSchema),
    update: oc
      .route({ method: "PUT", path: "/integrations/{integrationId}" })
      .input(
        z.object({
          integrationId: idSchema,
          name: z.string().optional(),
          config: integrationConfigSchema.optional(),
        })
      )
      .output(integrationWithConfigSchema),
    delete: oc
      .route({ method: "DELETE", path: "/integrations/{integrationId}" })
      .input(
        z.object({
          integrationId: idSchema,
        })
      )
      .output(z.object({ success: z.literal(true) })),
    testConnection: oc
      .route({ method: "POST", path: "/integrations/{integrationId}/test" })
      .input(
        z.object({
          integrationId: idSchema,
        })
      )
      .output(integrationTestResultSchema),
    testCredentials: oc
      .route({ method: "POST", path: "/integrations/test" })
      .input(
        z.object({
          type: integrationTypeSchema,
          config: integrationConfigSchema,
        })
      )
      .output(integrationTestResultSchema),
  },
  workflow: {
    getAll: oc
      .route({ method: "GET", path: "/workflows" })
      .input(z.object({}))
      .output(z.array(workflowApiPayloadSchema)),
    getById: oc
      .route({ method: "GET", path: "/workflows/{workflowId}" })
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    create: oc
      .route({ method: "POST", path: "/workflows/create" })
      .input(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          graph: serializedWorkflowGraphSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    update: oc
      .route({ method: "PATCH", path: "/workflows/{workflowId}" })
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
    delete: oc
      .route({ method: "DELETE", path: "/workflows/{workflowId}" })
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(z.object({ success: z.literal(true) })),
    duplicate: oc
      .route({ method: "POST", path: "/workflows/{workflowId}/duplicate" })
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    getCurrent: oc
      .route({ method: "GET", path: "/workflows/current" })
      .input(z.object({}))
      .output(workflowApiPayloadSchema),
    saveCurrent: oc
      .route({ method: "POST", path: "/workflows/current" })
      .input(
        z.object({
          graph: serializedWorkflowGraphSchema,
        })
      )
      .output(workflowApiPayloadSchema),
    execute: oc
      .route({ method: "POST", path: "/workflow/{workflowId}/execute" })
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
      .route({ method: "POST", path: "/workflows/{workflowId}/webhook" })
      .input(
        z.object({
          workflowId: idSchema,
          input: jsonObjectSchema.optional(),
        })
      )
      .output(workflowWebhookResponseSchema),
    getExecutions: oc
      .route({ method: "GET", path: "/workflows/{workflowId}/executions" })
      .input(
        z.object({
          workflowId: idSchema,
        })
      )
      .output(z.array(workflowExecutionSchema)),
    getExecutionsGlobal: oc
      .route({ method: "GET", path: "/workflows/executions" })
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
    bulkLifecycle: oc
      .route({ method: "POST", path: "/workflows/bulk-lifecycle" })
      .input(
        z.object({
          workflowIds: z.array(idSchema).min(1),
          action: workflowBulkActionSchema,
        })
      )
      .output(workflowBulkLifecycleResultSchema),
    deleteExecutions: oc
      .route({ method: "DELETE", path: "/workflows/{workflowId}/executions" })
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
      .route({
        method: "GET",
        path: "/workflows/executions/{executionId}/logs",
      })
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
      .route({
        method: "GET",
        path: "/workflows/executions/{executionId}/events",
      })
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
      .route({
        method: "POST",
        path: "/workflows/executions/{executionId}/cancel",
      })
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
      .route({
        method: "GET",
        path: "/workflows/executions/{executionId}/status",
      })
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
