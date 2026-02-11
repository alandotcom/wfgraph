import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getRun, start } from "workflow/api";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { getValueByPath, parseCsvSet } from "@/lib/utils/object-path";
import { logWorkflowAuditEvent } from "@/lib/workflow-audit";
import { executeWorkflow } from "@/lib/workflow-executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import {
  listWorkflowWaitingStatesByCorrelation,
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/lib/workflow-wait-state";

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  return trimmed;
}

function getTriggerNode(workflowNodes: WorkflowNode[]) {
  return workflowNodes.find((node) => node.data.type === "trigger");
}

async function cancelWaitingRuns(input: {
  workflowId: string;
  userId: string;
  waitStates: Array<{
    id: string;
    executionId: string;
    runId: string;
  }>;
  reason: string;
  eventType?: string;
}) {
  const uniqueRunIds = Array.from(
    new Set(input.waitStates.map((w) => w.runId))
  );
  const uniqueExecutionIds = Array.from(
    new Set(input.waitStates.map((w) => w.executionId))
  );

  for (const runId of uniqueRunIds) {
    try {
      await getRun(runId).cancel();
    } catch (error) {
      console.error(`[Execute] Failed to cancel run ${runId}:`, error);
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
      userId: input.userId,
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

export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // Get session
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get workflow and verify ownership
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (workflow.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Validate that all integrationIds in workflow nodes belong to the current user
    const validation = await validateWorkflowIntegrations(
      workflow.nodes as WorkflowNode[],
      session.user.id
    );
    if (!validation.valid) {
      console.error(
        "[Workflow Execute] Invalid integration references:",
        validation.invalidIds
      );
      return NextResponse.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403 }
      );
    }

    // Parse request body
    const body = (await request.json().catch(() => ({}))) as {
      input?: Record<string, unknown>;
      dryRun?: boolean;
    };
    const workflowNodes = workflow.nodes as WorkflowNode[];
    const workflowEdges = workflow.edges as WorkflowEdge[];
    const triggerNode = getTriggerNode(workflowNodes);
    const triggerConfig = triggerNode?.data.config ?? {};
    const isWebhookTrigger = triggerConfig.triggerType === "Webhook";
    const input = body.input ?? {};
    const dryRun = body.dryRun === true;
    const mockInputRaw = asNonEmptyString(triggerConfig.webhookMockRequest);
    let effectiveInput = input;

    if (
      isWebhookTrigger &&
      Object.keys(input).length === 0 &&
      mockInputRaw !== undefined
    ) {
      try {
        const parsed = JSON.parse(mockInputRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          effectiveInput = parsed as Record<string, unknown>;
        }
      } catch (error) {
        console.error("[Execute] Failed to parse webhook mock payload:", error);
      }
    }

    const eventTypePath =
      asNonEmptyString(triggerConfig.webhookEventPath) ?? "event";
    const correlationPath =
      asNonEmptyString(triggerConfig.webhookCorrelationPath) ?? "data.id";
    const eventType = asNonEmptyString(
      getValueByPath(effectiveInput, eventTypePath)
    );
    const correlationKey = asNonEmptyString(
      getValueByPath(effectiveInput, correlationPath)
    );
    const createEvents = parseCsvSet(
      triggerConfig.webhookCreateEvents ?? "event.create"
    );
    const updateEvents = parseCsvSet(
      triggerConfig.webhookUpdateEvents ?? "event.update"
    );
    const deleteEvents = parseCsvSet(
      triggerConfig.webhookDeleteEvents ?? "event.delete"
    );
    let updateCancellationSummary:
      | {
          cancelledExecutions: number;
          cancelledWaits: number;
          simulated?: boolean;
        }
      | undefined;

    if (isWebhookTrigger && eventType && deleteEvents.has(eventType)) {
      const waitStates =
        correlationKey === undefined
          ? []
          : await listWorkflowWaitingStatesByCorrelation({
              workflowId,
              correlationKey,
            });

      if (waitStates.length === 0) {
        return NextResponse.json({
          status: "ignored",
          reason: "no_waiting_runs",
          dryRun,
        });
      }

      if (dryRun) {
        return NextResponse.json({
          status: "cancelled",
          simulated: true,
          dryRun: true,
          cancelledExecutions: new Set(
            waitStates.map((state) => state.executionId)
          ).size,
          cancelledWaits: waitStates.length,
        });
      }

      const cancellation = await cancelWaitingRuns({
        workflowId,
        userId: session.user.id,
        waitStates,
        eventType,
        reason: `Cancelled by execute event ${eventType}`,
      });

      return NextResponse.json({
        status: "cancelled",
        ...cancellation,
        dryRun: false,
      });
    }

    if (
      isWebhookTrigger &&
      eventType &&
      createEvents.size > 0 &&
      !createEvents.has(eventType) &&
      !updateEvents.has(eventType)
    ) {
      return NextResponse.json({
        status: "ignored",
        reason: "event_not_configured",
        dryRun,
      });
    }

    if (isWebhookTrigger && eventType && updateEvents.has(eventType)) {
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
            userId: session.user.id,
            waitStates,
            eventType,
            reason: `Cancelled by execute event ${eventType}`,
          });
        }
      }
    }

    // Create execution record
    const [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId: session.user.id,
        status: "running",
        triggerType: isWebhookTrigger ? "webhook" : "manual",
        isDryRun: dryRun,
        triggerEventType: eventType,
        correlationKey,
        input: effectiveInput,
      })
      .returning();

    const run = await start(executeWorkflow, [
      {
        nodes: workflowNodes,
        edges: workflowEdges,
        triggerInput: effectiveInput,
        executionId: execution.id,
        workflowId,
        userId: session.user.id,
        dryRun,
        eventContext: {
          eventType,
          correlationKey,
        },
      },
    ]).catch(async (error) => {
      await db
        .update(workflowExecutions)
        .set({
          status: "error",
          error:
            error instanceof Error ? error.message : "Failed to enqueue run",
          completedAt: new Date(),
        })
        .where(eq(workflowExecutions.id, execution.id));
      throw error;
    });

    await db
      .update(workflowExecutions)
      .set({
        workflowRunId: run.runId,
      })
      .where(eq(workflowExecutions.id, execution.id));

    await logWorkflowAuditEvent({
      workflowId,
      executionId: execution.id,
      userId: session.user.id,
      eventType: "run_started",
      message: dryRun ? "Manual dry run started" : "Manual run started",
      metadata: {
        triggerType: isWebhookTrigger ? "webhook" : "manual",
        dryRun,
        eventType,
        correlationKey,
        runId: run.runId,
      },
    });

    // Return immediately with the execution ID
    return NextResponse.json({
      executionId: execution.id,
      runId: run.runId,
      status: "running",
      dryRun,
      ...(updateCancellationSummary ?? {}),
    });
  } catch (error) {
    console.error("Failed to start workflow execution:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute workflow",
      },
      { status: 500 }
    );
  }
}
