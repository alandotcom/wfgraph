import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { validateWorkflowIntegrations } from "@/backend/lib/db/integrations";
import { workflowExecutions, workflows } from "@/backend/lib/db/schema";
import { sendWorkflowRunRequested } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { cancelWaitingRuns } from "@/backend/lib/workflow-cancellation";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { listWorkflowWaitingStatesByCorrelation } from "@/backend/lib/workflow-wait-state";
import { orchestrateTriggerExecution } from "@/backend/services/workflows/trigger-orchestrator.workflows";
import type { WorkflowExecuteResponse } from "@/shared/workflow/execution-contracts";
import {
  evaluateWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@/shared/workflow/types";

const executeLogger = getAppLogger("workflow", "execute");

function getTriggerNode(workflowNodes: WorkflowNode[]) {
  return workflowNodes.find((node) => node.data.type === "trigger");
}

async function createTerminalExecution(input: {
  workflowId: string;
  triggerType: "manual" | "webhook";
  isDryRun: boolean;
  triggerEventType?: string;
  correlationKey?: string;
  payload: Record<string, unknown>;
  status: "success" | "error" | "cancelled";
  error?: string;
  output?: Record<string, unknown>;
  auditEventType: "run_cancelled" | "run_ignored" | "run_completed";
  auditMessage: string;
  auditMetadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: input.status,
      triggerType: input.triggerType,
      isDryRun: input.isDryRun,
      triggerEventType: input.triggerEventType,
      correlationKey: input.correlationKey,
      input: input.payload,
      output: input.output,
      error: input.error,
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

async function startExecution(input: {
  workflowId: string;
  workflowName: string;
  workflowGraph: SerializedWorkflowGraph;
  triggerType: "manual" | "webhook";
  payload: Record<string, unknown>;
  requestPayload: Record<string, unknown>;
  eventType?: string;
  correlationKey?: string;
  dryRun: boolean;
}) {
  const [startedExecution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: "running",
      triggerType: input.triggerType,
      isDryRun: input.dryRun,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
    })
    .returning();

  const run = await sendWorkflowRunRequested({
    graph: input.workflowGraph,
    triggerInput: input.payload,
    requestPayload: input.requestPayload,
    executionId: startedExecution.id,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    dryRun: input.dryRun,
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
      .where(eq(workflowExecutions.id, startedExecution.id));
    throw error;
  });

  await db
    .update(workflowExecutions)
    .set({ workflowRunId: run.eventId ?? null })
    .where(eq(workflowExecutions.id, startedExecution.id));

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    executionId: startedExecution.id,
    eventType: "run_started",
    message: input.dryRun ? "Manual dry run started" : "Manual run started",
    metadata: {
      triggerType: input.triggerType,
      dryRun: input.dryRun,
      eventType: input.eventType,
      correlationKey: input.correlationKey,
      runId: run.eventId,
    },
  });

  return {
    executionId: startedExecution.id,
    runId: run.eventId,
    dryRun: input.dryRun,
  };
}

function buildIgnoredAuditMessage(input: {
  reason: "missing_event_type" | "event_not_configured" | "no_waiting_runs";
  eventType?: string;
  eventTypePath?: string;
}): string {
  if (input.reason === "missing_event_type") {
    return `Ignored webhook event because event type is missing at path "${input.eventTypePath ?? "event"}"`;
  }

  if (input.reason === "event_not_configured") {
    return input.eventType
      ? `Ignored execute event ${input.eventType}`
      : "Ignored execute event not configured by trigger routing";
  }

  return input.eventType
    ? `Ignored ${input.eventType} because no waiting runs were found`
    : "Ignored event because no waiting runs were found";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Execute route coordinates trigger parsing, cancellation, and run creation in one request handler.
export async function postWorkflowExecute(
  workflowId: string,
  body: {
    input?: Record<string, unknown>;
    dryRun?: boolean;
  }
) {
  const requestLogger = executeLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    const graphValidation = validateWorkflowGraph(workflow.graph);
    if (!graphValidation.valid) {
      requestLogger.error("Invalid workflow graph", {
        workflowName: workflow.name,
        error: graphValidation.error,
      });
      return Response.json(
        { error: "Workflow graph is invalid" },
        { status: 400 }
      );
    }

    const integrationValidation = await validateWorkflowIntegrations(
      graphValidation.nodes
    );
    if (!integrationValidation.valid) {
      requestLogger.error("Invalid integration references in workflow", {
        workflowName: workflow.name,
        invalidIntegrationIds: integrationValidation.invalidIds,
      });
      return Response.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403 }
      );
    }

    const triggerNode = getTriggerNode(graphValidation.nodes);
    const triggerConfig = triggerNode?.data.config ?? {};
    const triggerConfigRecord = triggerConfig as Record<string, unknown>;
    const triggerDefinition =
      resolveWorkflowTriggerDefinition(triggerConfigRecord);
    const isWebhookTrigger = triggerDefinition.executionType === "webhook";
    const input = body.input ?? {};
    const dryRun = body.dryRun === true;
    let effectiveInput = input;

    if (isWebhookTrigger && Object.keys(input).length === 0) {
      const mockInput = triggerDefinition.parseMockInput?.(triggerConfigRecord);
      if (mockInput) {
        effectiveInput = mockInput;
      }
    }

    const { eventType, correlationKey, routingDecision, metadata } =
      evaluateWorkflowTrigger({
        config: triggerConfigRecord,
        payload: effectiveInput,
      });

    requestLogger.info("Workflow execute request received", {
      workflowName: workflow.name,
      triggerType: triggerDefinition.type.toLowerCase(),
      dryRun,
      requestPayloadKeys: Object.keys(body.input ?? {}),
      effectiveInputKeys: Object.keys(effectiveInput),
      eventType,
      correlationKey,
    });

    if (!isWebhookTrigger) {
      const startedExecution = await startExecution({
        workflowId,
        workflowName: workflow.name,
        workflowGraph: graphValidation.graph,
        triggerType: "manual",
        payload: effectiveInput,
        requestPayload: body.input ?? {},
        eventType,
        correlationKey,
        dryRun,
      });

      const response: WorkflowExecuteResponse = {
        status: "running",
        executionId: startedExecution.executionId,
        runId: startedExecution.runId,
        dryRun,
      };
      return Response.json(response);
    }

    const waitStates =
      correlationKey === undefined
        ? []
        : await listWorkflowWaitingStatesByCorrelation({
            workflowId,
            correlationKey,
          });

    const orchestrated = await orchestrateTriggerExecution({
      dryRun,
      eventType,
      correlationKey,
      eventTypePath: metadata?.eventTypePath,
      routingDecision,
      waitStates,
      enableResumes: false,
      startExecution: async () =>
        await startExecution({
          workflowId,
          workflowName: workflow.name,
          workflowGraph: graphValidation.graph,
          triggerType: "webhook",
          payload: effectiveInput,
          requestPayload: body.input ?? {},
          eventType,
          correlationKey,
          dryRun,
        }),
      cancelWaitStates: async (currentEventType) =>
        await cancelWaitingRuns({
          workflowId,
          waitStates,
          eventType: currentEventType,
          reason: `Cancelled by execute event ${currentEventType}`,
          logger: executeLogger,
        }),
      resumeWaitStates: async () => 0,
    });

    if (orchestrated.status === "running") {
      const response: WorkflowExecuteResponse = {
        status: "running",
        executionId: orchestrated.executionId,
        runId: orchestrated.runId,
        dryRun: orchestrated.dryRun,
        cancelledExecutions: orchestrated.cancelledExecutions,
        cancelledWaits: orchestrated.cancelledWaits,
        simulated: orchestrated.simulated,
      };
      return Response.json(response);
    }

    if (orchestrated.status === "cancelled") {
      let cancellationAuditMessage =
        "Cancelled waiting runs from execute request";
      if (eventType && dryRun) {
        cancellationAuditMessage = `Simulated cancellation by execute event ${eventType}`;
      } else if (eventType) {
        cancellationAuditMessage = `Cancelled by execute event ${eventType}`;
      }

      const terminalExecution = await createTerminalExecution({
        workflowId,
        triggerType: "webhook",
        isDryRun: orchestrated.dryRun,
        triggerEventType: eventType,
        correlationKey,
        payload: effectiveInput,
        status: "cancelled",
        output: {
          status: orchestrated.status,
          dryRun: orchestrated.dryRun,
          simulated: orchestrated.simulated,
          cancelledExecutions: orchestrated.cancelledExecutions,
          cancelledWaits: orchestrated.cancelledWaits,
          failedExecutions: orchestrated.failedExecutions,
        },
        auditEventType: "run_cancelled",
        auditMessage: cancellationAuditMessage,
        auditMetadata: {
          eventType,
          correlationKey,
          cancelledExecutions: orchestrated.cancelledExecutions,
          cancelledWaits: orchestrated.cancelledWaits,
          failedExecutions: orchestrated.failedExecutions,
          simulated: orchestrated.simulated,
        },
      });

      const response: WorkflowExecuteResponse = {
        status: "cancelled",
        executionId: terminalExecution.id,
        dryRun: orchestrated.dryRun,
        cancelledExecutions: orchestrated.cancelledExecutions,
        cancelledWaits: orchestrated.cancelledWaits,
        failedExecutions: orchestrated.failedExecutions,
        simulated: orchestrated.simulated,
      };
      return Response.json(response);
    }

    if (orchestrated.status === "resumed") {
      requestLogger.error(
        "Unexpected resumed outcome for manual execute orchestration"
      );
      return Response.json(
        {
          error: "Unexpected routing outcome while executing workflow",
        },
        { status: 500 }
      );
    }

    const ignoredReason = orchestrated.reason;
    const terminalExecution = await createTerminalExecution({
      workflowId,
      triggerType: "webhook",
      isDryRun: dryRun,
      triggerEventType: eventType,
      correlationKey,
      payload: effectiveInput,
      status: "success",
      output: {
        status: "ignored",
        reason: ignoredReason,
        eventTypePath: orchestrated.eventTypePath,
        dryRun,
      },
      auditEventType: "run_ignored",
      auditMessage: buildIgnoredAuditMessage({
        reason: ignoredReason,
        eventType,
        eventTypePath: orchestrated.eventTypePath,
      }),
      auditMetadata: {
        eventType,
        correlationKey,
        reason: ignoredReason,
        eventTypePath: orchestrated.eventTypePath,
        dryRun,
      },
    });

    const response: WorkflowExecuteResponse = {
      status: "ignored",
      executionId: terminalExecution.id,
      dryRun,
      reason: ignoredReason,
      eventTypePath: orchestrated.eventTypePath,
    };

    return Response.json(response);
  } catch (error) {
    requestLogger.error("Failed to start workflow execution", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute workflow",
      },
      { status: 500 }
    );
  }
}
