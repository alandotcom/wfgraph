import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { validateWorkflowIntegrations } from "@/backend/lib/db/integrations";
import { workflowExecutions, workflows } from "@/backend/lib/db/schema";
import {
  sendWorkflowCancelRequested,
  sendWorkflowRunRequested,
  sendWorkflowWaitSignal,
} from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import {
  listWorkflowWaitingStatesByCorrelation,
  markExecutionCancelled,
  markExecutionRunning,
  markWaitingStatesCancelled,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";
import { validateApiKey } from "@/backend/services/api-keys/auth.api-keys";
import { parseCsvSet } from "@/shared/utils/object-path";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@/shared/workflow/types";
import {
  buildWebhookRoutingConfig,
  deriveWebhookEventContext,
  routeWebhookEvent,
} from "@/shared/workflow/webhook-routing";

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

async function cancelWaitingRuns(input: {
  workflowId: string;
  waitStates: Array<{
    id: string;
    executionId: string;
    nodeId: string;
    nodeName: string;
  }>;
  eventType?: string;
  reason: string;
}) {
  const uniqueExecutionIds = Array.from(
    new Set(input.waitStates.map((w) => w.executionId))
  );

  for (const executionId of uniqueExecutionIds) {
    try {
      await sendWorkflowCancelRequested({
        executionId,
        workflowId: input.workflowId,
        reason: input.reason,
        requestedBy: input.workflowId,
        eventType: input.eventType,
      });
    } catch (error) {
      webhookLogger.error("Failed to send cancel signal for execution", {
        workflowId: input.workflowId,
        executionId,
        eventType: input.eventType,
        error,
      });
    }
  }

  await markWaitingStatesCancelled(input.waitStates.map((state) => state.id));

  for (const executionId of uniqueExecutionIds) {
    await markExecutionCancelled({
      executionId,
      error: input.reason,
    });

    await logWorkflowAuditEvent({
      workflowId: input.workflowId,
      executionId,
      eventType: "run_cancelled",
      message: input.reason,
      metadata: {
        eventType: input.eventType,
      },
    });
  }

  return {
    cancelledExecutions: uniqueExecutionIds.length,
    cancelledWaits: input.waitStates.length,
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
    return { resumedCount: 0 };
  }

  let resumedCount = 0;

  for (const waitState of input.waitStates) {
    if (!waitState.hookToken) {
      continue;
    }

    const metadata = waitState.metadata ?? {};
    const waitForEvents = parseCsvSet(metadata.waitForEvents);
    const shouldResume =
      waitForEvents.size === 0 || waitForEvents.has(input.eventType);

    if (!shouldResume) {
      continue;
    }

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

      await markWaitStateStatus({
        waitStateId: waitState.id,
        status: "resumed",
      });
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

  return { resumedCount };
}

export function optionsWorkflowWebhook() {
  return Response.json({}, { headers: corsHeaders });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Webhook orchestration requires branching for create/update/delete/resume flows
export async function postWorkflowWebhook(input: {
  workflowId: string;
  authHeader: string | null;
  dryRunQuery?: "true" | "false";
  dryRunHeader: string | null;
  body: Record<string, unknown>;
}) {
  const requestLogger = webhookLogger.with({ workflowId: input.workflowId });
  try {
    const { workflowId, authHeader, dryRunQuery, dryRunHeader, body } = input;

    // Get workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return Response.json(
        { error: "Workflow not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // Validate API key
    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      return Response.json(
        { error: apiKeyValidation.error },
        { status: apiKeyValidation.statusCode || 401, headers: corsHeaders }
      );
    }

    const graphValidation = validateWorkflowGraph(workflow.graph);
    if (!graphValidation.valid) {
      requestLogger.error("Invalid workflow graph", {
        workflowName: workflow.name,
        error: graphValidation.error,
      });
      return Response.json(
        { error: "Workflow graph is invalid" },
        { status: 400, headers: corsHeaders }
      );
    }

    const workflowNodes = graphValidation.nodes;
    const workflowGraph = graphValidation.graph;

    // Verify this is a webhook-triggered workflow
    const triggerNode = getTriggerNode(workflowNodes);

    if (!triggerNode || triggerNode.data.config?.triggerType !== "Webhook") {
      return Response.json(
        { error: "This workflow is not configured for webhook triggers" },
        { status: 400, headers: corsHeaders }
      );
    }

    const validation = await validateWorkflowIntegrations(workflowNodes);
    if (!validation.valid) {
      requestLogger.error("Invalid integration references in workflow", {
        workflowName: workflow.name,
        invalidIntegrationIds: validation.invalidIds,
      });
      return Response.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403, headers: corsHeaders }
      );
    }

    const dryRunFromQuery = parseBooleanFlag(dryRunQuery ?? null);
    const dryRunFromHeader = parseBooleanFlag(dryRunHeader);
    const dryRun = dryRunFromQuery ?? dryRunFromHeader ?? false;

    const routing = buildWebhookRoutingConfig(triggerNode.data.config);
    const eventTypePath = routing.eventTypePath;
    const correlationPath = routing.correlationPath;
    const { eventType, correlationKey } = deriveWebhookEventContext(
      body,
      routing
    );
    const routingDecision = routeWebhookEvent({
      eventType,
      routing,
    });

    requestLogger.info("Webhook request received", {
      workflowName: workflow.name,
      dryRun,
      eventTypePath,
      correlationPath,
      eventType,
      correlationKey,
      requestPayload: body,
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

    if (
      routingDecision.kind === "ignore" &&
      routingDecision.reason === "missing_event_type"
    ) {
      await logWorkflowAuditEvent({
        workflowId,
        eventType: "run_ignored",
        message: `Ignored webhook: event type missing at path "${eventTypePath}"`,
        metadata: {
          eventTypePath,
          correlationPath,
          correlationKey,
          dryRun,
        },
      });

      return Response.json(
        {
          status: "ignored",
          reason: "missing_event_type",
          eventTypePath,
        },
        { headers: corsHeaders }
      );
    }

    const waitingStates =
      correlationKey === undefined
        ? []
        : await listWorkflowWaitingStatesByCorrelation({
            workflowId,
            correlationKey,
          });
    const dryRunCancellationSummary = {
      cancelledExecutions: new Set(
        waitingStates.map((state) => state.executionId)
      ).size,
      cancelledWaits: waitingStates.length,
    };

    if (routingDecision.kind === "delete" && eventType) {
      if (waitingStates.length === 0) {
        await logWorkflowAuditEvent({
          workflowId,
          eventType: "run_ignored",
          message: `Ignored ${eventType} because no waiting runs were found`,
          metadata: {
            eventType,
            correlationKey,
          },
        });

        return Response.json(
          {
            status: "ignored",
            reason: "no_waiting_runs",
          },
          { headers: corsHeaders }
        );
      }

      if (dryRun) {
        return Response.json(
          {
            status: "cancelled",
            dryRun: true,
            simulated: true,
            ...dryRunCancellationSummary,
          },
          { headers: corsHeaders }
        );
      }

      const cancellation = await cancelWaitingRuns({
        workflowId,
        waitStates: waitingStates,
        eventType,
        reason: `Cancelled by webhook event ${eventType}`,
      });

      return Response.json(
        {
          status: "cancelled",
          ...cancellation,
        },
        { headers: corsHeaders }
      );
    }

    if (routingDecision.kind === "update" && eventType) {
      if (waitingStates.length === 0) {
        await logWorkflowAuditEvent({
          workflowId,
          eventType: "run_ignored",
          message: `Ignored ${eventType} because no waiting runs were found`,
          metadata: {
            eventType,
            correlationKey,
          },
        });

        return Response.json(
          {
            status: "ignored",
            reason: "no_waiting_runs",
          },
          { headers: corsHeaders }
        );
      }

      if (dryRun) {
        const execution = await startWebhookExecution({
          workflowId,
          workflowName: workflow.name,
          workflowGraph,
          payload: body,
          eventType,
          correlationKey,
          dryRun: true,
        });

        return Response.json(
          {
            executionId: execution.executionId,
            runId: execution.runId,
            status: "running",
            dryRun: true,
            simulated: true,
            ...dryRunCancellationSummary,
          },
          { headers: corsHeaders }
        );
      }

      const cancellation = await cancelWaitingRuns({
        workflowId,
        waitStates: waitingStates,
        eventType,
        reason: `Cancelled by webhook event ${eventType}`,
      });

      const execution = await startWebhookExecution({
        workflowId,
        workflowName: workflow.name,
        workflowGraph,
        payload: body,
        eventType,
        correlationKey,
        dryRun,
      });

      return Response.json(
        {
          executionId: execution.executionId,
          runId: execution.runId,
          status: "running",
          dryRun,
          ...cancellation,
        },
        { headers: corsHeaders }
      );
    }

    if (eventType && correlationKey && waitingStates.length > 0) {
      if (dryRun) {
        const resumedCount = waitingStates.filter((waitState) => {
          if (!waitState.hookToken) {
            return false;
          }

          const metadata =
            (waitState.metadata as Record<string, unknown> | null) ?? {};
          const waitForEvents = parseCsvSet(metadata.waitForEvents);
          return waitForEvents.size === 0 || waitForEvents.has(eventType);
        }).length;

        if (resumedCount > 0) {
          return Response.json(
            {
              status: "resumed",
              resumedCount,
              dryRun: true,
              simulated: true,
            },
            { headers: corsHeaders }
          );
        }
      }

      const resumed = await resumeMatchingWaitHooks({
        workflowId,
        eventType,
        payload: body,
        waitStates: waitingStates,
      });

      if (resumed.resumedCount > 0) {
        return Response.json(
          {
            status: "resumed",
            resumedCount: resumed.resumedCount,
          },
          { headers: corsHeaders }
        );
      }
    }

    // Event types not configured to create runs are ignored.
    if (
      routingDecision.kind === "ignore" &&
      routingDecision.reason === "event_not_configured" &&
      eventType
    ) {
      await logWorkflowAuditEvent({
        workflowId,
        eventType: "run_ignored",
        message: `Ignored webhook event ${eventType}`,
        metadata: {
          eventType,
          correlationKey,
        },
      });

      return Response.json(
        {
          status: "ignored",
          reason: "event_not_configured",
        },
        { headers: corsHeaders }
      );
    }

    if (dryRun) {
      const execution = await startWebhookExecution({
        workflowId,
        workflowName: workflow.name,
        workflowGraph,
        payload: body,
        eventType,
        correlationKey,
        dryRun: true,
      });

      return Response.json(
        {
          executionId: execution.executionId,
          runId: execution.runId,
          status: "running",
          dryRun: true,
        },
        { headers: corsHeaders }
      );
    }

    const execution = await startWebhookExecution({
      workflowId,
      workflowName: workflow.name,
      workflowGraph,
      payload: body,
      eventType,
      correlationKey,
      dryRun,
    });

    return Response.json(
      {
        executionId: execution.executionId,
        runId: execution.runId,
        status: "running",
        dryRun,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    requestLogger.error("Failed to start workflow execution", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute workflow",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
