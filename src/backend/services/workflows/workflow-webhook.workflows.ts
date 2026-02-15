import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { validateWorkflowIntegrations } from "@/backend/lib/db/integrations";
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
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { cancelWaitingRuns } from "@/backend/lib/workflow-cancellation";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import {
  listWorkflowWaitingStatesByCorrelation,
  markExecutionRunning,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";
import { validateApiKey } from "@/backend/services/api-keys/auth.api-keys";
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

  let resumedCount = 0;

  for (const waitState of input.waitStates) {
    if (!waitState.hookToken) {
      continue;
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
        continue;
      }

      await markExecutionRunning(waitState.executionId);

      await logWorkflowAuditEvent({
        workflowId: input.workflowId,
        executionId: waitState.executionId,
        eventType: "run_resumed",
        message: `Run resumed from wait on ${input.eventType}`,
        metadata: {
          eventType: input.eventType,
        },
      });

      resumedCount += 1;
    } catch (error) {
      webhookLogger.error("Failed to resume hook", {
        workflowId: input.workflowId,
        eventType: input.eventType,
        waitStateId: waitState.id,
        executionId: waitState.executionId,
        nodeId: waitState.nodeId,
        error,
      });
    }
  }

  return resumedCount;
}

function buildIgnoredAuditMessage(input: {
  reason: "missing_event_type" | "event_not_configured" | "no_waiting_runs";
  eventType?: string;
  eventTypePath?: string;
}): string {
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

export async function postWorkflowWebhookResult(input: {
  workflowId: string;
  authHeader: string | null;
  dryRunQuery?: "true" | "false";
  dryRunHeader: string | null;
  body: Record<string, unknown>;
}): Promise<ServiceResult<WorkflowWebhookResponse, number, { error: string }>> {
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

    const workflowNodes = graphValidation.nodes;
    const workflowGraph = graphValidation.graph;

    const triggerNode = getTriggerNode(workflowNodes);

    const triggerConfig = (triggerNode?.data.config ?? undefined) as
      | Record<string, unknown>
      | undefined;
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
      });
    }

    const dryRunFromQuery = parseBooleanFlag(dryRunQuery ?? null);
    const dryRunFromHeader = parseBooleanFlag(dryRunHeader);
    const dryRun = dryRunFromQuery ?? dryRunFromHeader ?? false;

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
