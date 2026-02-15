import { oc } from "@orpc/contract";
import { z } from "zod";
import { serializedWorkflowGraphSchema } from "@/shared/workflow/schemas";

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

const workflowApiPayloadSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  graph: serializedWorkflowGraphSchema,
  visibility: z.enum(["private", "public"]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  isOwner: z.boolean().optional(),
});

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
  triggerType: z.enum(["manual", "webhook"]).nullable(),
  isDryRun: z.boolean(),
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
]);

const workflowExecutionRunningSchema = z
  .object({
    status: z.literal("running"),
    executionId: z.string(),
    runId: z.string().optional(),
    dryRun: z.boolean(),
    cancelledExecutions: z.number().optional(),
    cancelledWaits: z.number().optional(),
    simulated: z.boolean().optional(),
  })
  .passthrough();

const workflowExecutionCancelledSchema = z
  .object({
    status: z.literal("cancelled"),
    executionId: z.string().optional(),
    dryRun: z.boolean(),
    cancelledExecutions: z.number(),
    cancelledWaits: z.number(),
    simulated: z.boolean().optional(),
    failedExecutions: z.array(z.string()).optional(),
  })
  .passthrough();

const workflowExecutionIgnoredSchema = z
  .object({
    status: z.literal("ignored"),
    executionId: z.string().optional(),
    dryRun: z.boolean().optional(),
    reason: ignoredReasonSchema,
    eventTypePath: z.string().optional(),
  })
  .passthrough();

const workflowExecutionResumedSchema = z
  .object({
    status: z.literal("resumed"),
    resumedCount: z.number(),
    dryRun: z.boolean().optional(),
    simulated: z.boolean().optional(),
  })
  .passthrough();

const workflowExecuteResponseSchema = z.discriminatedUnion("status", [
  workflowExecutionRunningSchema,
  workflowExecutionCancelledSchema.extend({
    executionId: z.string(),
  }),
  workflowExecutionIgnoredSchema.extend({
    executionId: z.string(),
    dryRun: z.boolean(),
  }),
]);

const workflowWebhookResponseSchema = z.discriminatedUnion("status", [
  workflowExecutionRunningSchema,
  workflowExecutionCancelledSchema,
  workflowExecutionIgnoredSchema,
  workflowExecutionResumedSchema,
]);

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
          input: z.record(z.string(), z.unknown()).optional(),
          dryRun: z.boolean().optional(),
        })
      )
      .output(workflowExecuteResponseSchema),
    triggerWebhook: oc
      .route({ method: "POST", path: "/workflows/{workflowId}/webhook" })
      .input(
        z.object({
          workflowId: idSchema,
          input: z.record(z.string(), z.unknown()).optional(),
          dryRun: z.boolean().optional(),
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
