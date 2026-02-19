import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions, workflows } from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import {
  sendWorkflowRunRequested,
  sendWorkflowWaitSignal,
} from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { validateWorkflowActionConfigs } from "@/backend/lib/workflow-action-validation";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { cancelWaitingRuns } from "@/backend/lib/workflow-cancellation";
import { validateWorkflowConditionConfigs } from "@/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "@/backend/lib/workflow-integration-validation";
import {
  listWorkflowWaitingStatesByCorrelation,
  markExecutionRunning,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";
import { validateApiKey } from "@/backend/services/api-keys/auth.api-keys";
import type { ApiErrorPayload } from "@/shared/workflow/api-contracts";
import type { WorkflowWebhookResponse } from "@/shared/workflow/execution-contracts";
import {
  evaluateWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@/shared/workflow/types";
import { orchestrateTriggerExecution } from "./trigger-orchestrator.workflows";

const webhookLogger = getAppLogger("workflow", "webhook");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function parseBooleanFlag(value: string | null): boolean | undefined {
  if (value === null) {
    return;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return;
}

function getTriggerNode(workflowNodes: WorkflowNode[]) {
  return workflowNodes.find((node) => node.data.type === "trigger");
}

async function startWebhookExecution(input: {
  workflowId: string;
  workflowName: string;
  workflowGraph: SerializedWorkflowGraph;
  payload: Record<string, unknown>;
  eventType?: string;
  correlationKey?: string;
  dryRun?: boolean;
}) {
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: "running",
      triggerType: "webhook",
      isDryRun: input.dryRun === true,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
    })
    .returning();

  const run = await sendWorkflowRunRequested({
    graph: input.workflowGraph,
    triggerInput: input.payload,
    requestPayload: input.payload,
    executionId: execution.id,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    dryRun: input.dryRun === true,
    eventContext: {
      eventType: input.eventType,
      correlationKey: input.correlationKey,
    },
  }).catch(async (error) => {
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: error instanceof Error ? error.message : "Failed to enqueue run",
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, execution.id));
    throw error;
  });

  await db
    .update(workflowExecutions)
    .set({
      workflowRunId: run.eventId ?? null,
    })
    .where(eq(workflowExecutions.id, execution.id));

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    executionId: execution.id,
    eventType: "run_started",
    message: `${input.dryRun ? "Webhook dry run started" : "Webhook run started"}${input.eventType ? ` for ${input.eventType}` : ""}`,
    metadata: {
      triggerType: "webhook",
      dryRun: input.dryRun === true,
      eventType: input.eventType,
      correlationKey: input.correlationKey,
      runId: run.eventId,
    },
  });

  return {
    executionId: execution.id,
    runId: run.eventId,
    dryRun: input.dryRun === true,
  };
}

async function createTerminalWebhookExecution(input: {
  workflowId: string;
  payload: Record<string, unknown>;
  dryRun: boolean;
  status: "success" | "cancelled";
  eventType?: string;
  correlationKey?: string;
  output: Record<string, unknown>;
  auditEventType: "run_ignored" | "run_cancelled";
  auditMessage: string;
  auditMetadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: input.status,
      triggerType: "webhook",
      isDryRun: input.dryRun,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
      output: input.output,
      startedAt: now,
      completedAt: now,
      cancelledAt: input.status === "cancelled" ? now : null,
    })
    .returning();

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    executionId: execution.id,
    eventType: input.auditEventType,
    message: input.auditMessage,
    metadata: input.auditMetadata,
  });

  return execution;
}

async function resumeMatchingWaitHooks(input: {
  workflowId: string;
  eventType?: string;
  payload: Record<string, unknown>;
  waitStates: Array<{
    id: string;
    executionId: string;
    nodeId: string;
    hookToken: string | null;
    metadata: Record<string, unknown> | null;
  }>;
}) {
  if (!input.eventType) {
    return 0;
  }

  const resumeResults = await Promise.all(
    input.waitStates.map(async (waitState) => {
      if (!waitState.hookToken) {
        return 0;
      }

      const metadata = waitState.metadata ?? {};

      try {
        await sendWorkflowWaitSignal({
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          token: waitState.hookToken,
          eventType: input.eventType,
          correlationKey:
            typeof metadata.correlationKey === "string"
              ? metadata.correlationKey
              : undefined,
          payload: input.payload,
        });

        const waitStateUpdated = await markWaitStateStatus({
          waitStateId: waitState.id,
          status: "resumed",
        });

        if (!waitStateUpdated) {
          return 0;
        }

        await Promise.all([
          markExecutionRunning(waitState.executionId),
          logWorkflowAuditEvent({
            workflowId: input.workflowId,
            executionId: waitState.executionId,
            eventType: "run_resumed",
            message: `Run resumed from wait on ${input.eventType}`,
            metadata: {
              eventType: input.eventType,
            },
          }),
        ]);

        return 1;
      } catch (error) {
        webhookLogger.error("Failed to resume hook", {
          workflowId: input.workflowId,
          eventType: input.eventType,
          waitStateId: waitState.id,
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          error,
        });
        return 0;
      }
    })
  );

  return resumeResults.reduce<number>((total, count) => total + count, 0);
}

function buildIgnoredAuditMessage(input: {
  reason:
    | "missing_event_type"
    | "event_not_configured"
    | "no_waiting_runs"
    | "workflow_paused";
  eventType?: string;
  eventTypePath?: string;
}): string {
  if (input.reason === "workflow_paused") {
    return "Ignored webhook event because workflow is paused";
  }

  if (input.reason === "missing_event_type") {
    return `Ignored webhook: event type missing at path "${input.eventTypePath ?? "event"}"`;
  }

  if (input.reason === "event_not_configured") {
    return input.eventType
      ? `Ignored webhook event ${input.eventType}`
      : "Ignored webhook event not configured by routing";
  }

  return input.eventType
    ? `Ignored ${input.eventType} because no waiting runs were found`
    : "Ignored webhook event because no waiting runs were found";
}

export function optionsWorkflowWebhook() {
  return Response.json({}, { headers: corsHeaders });
}

export async function postWorkflowWebhook(input: {
  workflowId: string;
  authHeader: string | null;
  dryRunQuery?: "true" | "false";
  dryRunHeader: string | null;
  body: Record<string, unknown>;
}) {
  return responseFromServiceResult(await postWorkflowWebhookResult(input), {
    headers: corsHeaders,
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Endpoint orchestration intentionally combines auth, validation, routing, and run lifecycle decisions.
export async function postWorkflowWebhookResult(input: {
  workflowId: string;
  authHeader: string | null;
  dryRunQuery?: "true" | "false";
  dryRunHeader: string | null;
  body: Record<string, unknown>;
}): Promise<ServiceResult<WorkflowWebhookResponse, number, ApiErrorPayload>> {
  const requestLogger = webhookLogger.with({ workflowId: input.workflowId });
  try {
    const { workflowId, authHeader, dryRunQuery, dryRunHeader, body } = input;

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure(404, { error: "Workflow not found" });
    }

    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      return failure(apiKeyValidation.statusCode || 401, {
        error: apiKeyValidation.error,
      });
    }

    const graphValidation = validateWorkflowGraph(workflow.graph);
    if (!graphValidation.valid) {
      requestLogger.error("Invalid workflow graph", {
        workflowName: workflow.name,
        error: graphValidation.error,
      });
      return failure(400, { error: "Workflow graph is invalid" });
    }

    const actionValidation = validateWorkflowActionConfigs(
      graphValidation.nodes
    );
    if (!actionValidation.valid) {
      requestLogger.error("Invalid workflow action configuration", {
        workflowName: workflow.name,
        error: actionValidation.error,
      });
      return failure(400, { error: actionValidation.error });
    }

    const conditionValidation = validateWorkflowConditionConfigs(
      graphValidation.nodes
    );
    if (!conditionValidation.valid) {
      requestLogger.error("Invalid workflow condition configuration", {
        workflowName: workflow.name,
        error: conditionValidation.error,
      });
      return failure(400, { error: conditionValidation.error });
    }

    const workflowNodes = graphValidation.nodes;
    const workflowGraph = graphValidation.graph;

    const triggerNode = getTriggerNode(workflowNodes);

    const triggerConfig = triggerNode?.data.config;
    const triggerDefinition = resolveWorkflowTriggerDefinition(triggerConfig);

    if (!triggerNode || triggerDefinition.executionType !== "webhook") {
      return failure(400, {
        error: "This workflow is not configured for webhook triggers",
      });
    }

    const validation = await validateWorkflowIntegrations(workflowNodes);
    if (!validation.valid) {
      requestLogger.error("Invalid integration references in workflow", {
        workflowName: workflow.name,
        invalidIntegrationIds: validation.invalidIds,
      });
      return failure(403, {
        error: "Workflow contains invalid integration references",
        code: "integration_validation_failed",
        invalidIntegrationIds: validation.invalidIds ?? [],
      });
    }

    const dryRunFromQuery = parseBooleanFlag(dryRunQuery ?? null);
    const dryRunFromHeader = parseBooleanFlag(dryRunHeader);
    const dryRun = dryRunFromQuery ?? dryRunFromHeader ?? false;

    if (workflow.isPaused) {
      const ignoredExecution = await createTerminalWebhookExecution({
        workflowId,
        payload: body,
        dryRun,
        status: "success",
        output: {
          status: "ignored",
          reason: "workflow_paused",
          dryRun,
        },
        auditEventType: "run_ignored",
        auditMessage: buildIgnoredAuditMessage({
          reason: "workflow_paused",
        }),
        auditMetadata: {
          reason: "workflow_paused",
          dryRun,
        },
      });

      return success({
        status: "ignored",
        executionId: ignoredExecution.id,
        dryRun,
        reason: "workflow_paused",
      });
    }

    const { eventType, correlationKey, routingDecision, metadata } =
      evaluateWorkflowTrigger({
        config: triggerConfig,
        payload: body,
      });
    const eventTypePath = metadata?.eventTypePath ?? "event";
    const correlationPath = metadata?.correlationPath ?? "data.id";

    requestLogger.info("Webhook request received", {
      workflowName: workflow.name,
      dryRun,
      eventTypePath,
      correlationPath,
      eventType,
      correlationKey,
      requestPayloadKeys: Object.keys(body),
    });

    await logWorkflowAuditEvent({
      workflowId,
      eventType: "trigger_received",
      message: `Webhook received${eventType ? `: ${eventType}` : ""}`,
      metadata: {
        eventType,
        correlationKey,
        dryRun,
      },
    });

    const waitingStates =
      correlationKey === undefined
        ? []
        : await listWorkflowWaitingStatesByCorrelation({
            workflowId,
            correlationKey,
          });

    const outcome = await orchestrateTriggerExecution({
      dryRun,
      eventType,
      correlationKey,
      eventTypePath,
      routingDecision,
      waitStates: waitingStates,
      enableResumes: true,
      startExecution: async () =>
        await startWebhookExecution({
          workflowId,
          workflowName: workflow.name,
          workflowGraph,
          payload: body,
          eventType,
          correlationKey,
          dryRun,
        }),
      cancelWaitStates: async (currentEventType) =>
        await cancelWaitingRuns({
          workflowId,
          waitStates: waitingStates,
          eventType: currentEventType,
          reason: `Cancelled by webhook event ${currentEventType}`,
          logger: webhookLogger,
        }),
      resumeWaitStates: async (currentEventType, waitStates) =>
        await resumeMatchingWaitHooks({
          workflowId,
          eventType: currentEventType,
          payload: body,
          waitStates,
        }),
    });

    if (outcome.status === "ignored") {
      await logWorkflowAuditEvent({
        workflowId,
        eventType: "run_ignored",
        message: buildIgnoredAuditMessage({
          reason: outcome.reason,
          eventType,
          eventTypePath: outcome.eventTypePath,
        }),
        metadata: {
          eventType,
          eventTypePath,
          correlationPath,
          correlationKey,
          dryRun,
          reason: outcome.reason,
        },
      });
    }

    return success(outcome);
  } catch (error) {
    requestLogger.error("Failed to start workflow execution", { error });
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to execute workflow",
    });
  }
}
