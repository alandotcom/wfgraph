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
import {
  evaluateWorkflowTrigger,
  resolveWorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import type { WorkflowNode } from "@/shared/workflow/types";

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
    // Get workflow and verify ownership
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

    const workflowNodes = graphValidation.nodes;
    const triggerNode = getTriggerNode(workflowNodes);
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

    const { eventType, correlationKey, routingDecision } =
      evaluateWorkflowTrigger({
        config: triggerConfigRecord,
        payload: effectiveInput,
      });

    requestLogger.info("Workflow execute request received", {
      workflowName: workflow.name,
      triggerType: triggerDefinition.type.toLowerCase(),
      dryRun,
      requestPayload: body.input ?? {},
      effectiveInput,
    });

    let updateCancellationSummary:
      | {
          cancelledExecutions: number;
          cancelledWaits: number;
          simulated?: boolean;
        }
      | undefined;

    if (isWebhookTrigger && routingDecision.kind === "stop" && eventType) {
      const waitStates =
        correlationKey === undefined
          ? []
          : await listWorkflowWaitingStatesByCorrelation({
              workflowId,
              correlationKey,
            });

      if (waitStates.length === 0) {
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
            reason: "no_waiting_runs",
            dryRun,
          },
          auditEventType: "run_ignored",
          auditMessage: `Ignored ${eventType} because no waiting runs were found`,
          auditMetadata: {
            eventType,
            correlationKey,
            dryRun,
          },
        });

        return Response.json({
          executionId: terminalExecution.id,
          status: "ignored",
          reason: "no_waiting_runs",
          dryRun,
        });
      }

      if (dryRun) {
        const cancelledExecutions = new Set(
          waitStates.map((state) => state.executionId)
        ).size;
        const cancelledWaits = waitStates.length;
        const terminalExecution = await createTerminalExecution({
          workflowId,
          triggerType: "webhook",
          isDryRun: true,
          triggerEventType: eventType,
          correlationKey,
          payload: effectiveInput,
          status: "cancelled",
          output: {
            status: "cancelled",
            simulated: true,
            cancelledExecutions,
            cancelledWaits,
          },
          auditEventType: "run_cancelled",
          auditMessage: `Simulated cancellation by execute event ${eventType}`,
          auditMetadata: {
            eventType,
            correlationKey,
            simulated: true,
          },
        });

        return Response.json({
          executionId: terminalExecution.id,
          status: "cancelled",
          simulated: true,
          dryRun: true,
          cancelledExecutions,
          cancelledWaits,
        });
      }

      const cancellation = await cancelWaitingRuns({
        workflowId,
        waitStates,
        eventType,
        reason: `Cancelled by execute event ${eventType}`,
        logger: executeLogger,
      });

      const terminalExecution = await createTerminalExecution({
        workflowId,
        triggerType: "webhook",
        isDryRun: false,
        triggerEventType: eventType,
        correlationKey,
        payload: effectiveInput,
        status: "cancelled",
        output: {
          status: "cancelled",
          ...cancellation,
        },
        auditEventType: "run_cancelled",
        auditMessage: `Cancelled by execute event ${eventType}`,
        auditMetadata: {
          eventType,
          correlationKey,
          ...cancellation,
        },
      });

      return Response.json({
        executionId: terminalExecution.id,
        status: "cancelled",
        ...cancellation,
        dryRun: false,
      });
    }

    if (
      isWebhookTrigger &&
      routingDecision.kind === "ignore" &&
      routingDecision.reason === "event_not_configured" &&
      eventType
    ) {
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
          reason: "event_not_configured",
          dryRun,
        },
        auditEventType: "run_ignored",
        auditMessage: `Ignored execute event ${eventType}`,
        auditMetadata: {
          eventType,
          correlationKey,
          dryRun,
        },
      });

      return Response.json({
        executionId: terminalExecution.id,
        status: "ignored",
        reason: "event_not_configured",
        dryRun,
      });
    }

    if (isWebhookTrigger && routingDecision.kind === "restart" && eventType) {
      const waitStates =
        correlationKey === undefined
          ? []
          : await listWorkflowWaitingStatesByCorrelation({
              workflowId,
              correlationKey,
            });

      if (waitStates.length > 0) {
        if (dryRun) {
          updateCancellationSummary = {
            cancelledExecutions: new Set(
              waitStates.map((state) => state.executionId)
            ).size,
            cancelledWaits: waitStates.length,
            simulated: true,
          };
        } else {
          updateCancellationSummary = await cancelWaitingRuns({
            workflowId,
            waitStates,
            eventType,
            reason: `Cancelled by execute event ${eventType}`,
            logger: executeLogger,
          });
        }
      }
    }

    // Create execution record
    const [startedExecution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        status: "running",
        triggerType: isWebhookTrigger ? "webhook" : "manual",
        isDryRun: dryRun,
        triggerEventType: eventType,
        correlationKey,
        input: effectiveInput,
      })
      .returning();

    const run = await sendWorkflowRunRequested({
      graph: graphValidation.graph,
      triggerInput: effectiveInput,
      requestPayload: body.input ?? {},
      executionId: startedExecution.id,
      workflowId,
      workflowName: workflow.name,
      dryRun,
      eventContext: {
        eventType,
        correlationKey,
      },
    }).catch(async (error) => {
      await db
        .update(workflowExecutions)
        .set({
          status: "error",
          error:
            error instanceof Error ? error.message : "Failed to enqueue run",
          completedAt: new Date(),
        })
        .where(eq(workflowExecutions.id, startedExecution.id));
      throw error;
    });

    await db
      .update(workflowExecutions)
      .set({
        workflowRunId: run.eventId ?? null,
      })
      .where(eq(workflowExecutions.id, startedExecution.id));

    await logWorkflowAuditEvent({
      workflowId,
      executionId: startedExecution.id,
      eventType: "run_started",
      message: dryRun ? "Manual dry run started" : "Manual run started",
      metadata: {
        triggerType: isWebhookTrigger ? "webhook" : "manual",
        dryRun,
        eventType,
        correlationKey,
        runId: run.eventId,
      },
    });

    // Return immediately with the execution ID
    return Response.json({
      executionId: startedExecution.id,
      runId: run.eventId,
      status: "running",
      dryRun,
      ...(updateCancellationSummary ?? {}),
    });
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
