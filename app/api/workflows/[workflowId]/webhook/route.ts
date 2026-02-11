import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getRun, resumeHook, start } from "workflow/api";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { apiKeys, workflowExecutions, workflows } from "@/lib/db/schema";
import { getValueByPath, parseCsvSet } from "@/lib/utils/object-path";
import { logWorkflowAuditEvent } from "@/lib/workflow-audit";
import { executeWorkflow } from "@/lib/workflow-executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import {
  listWorkflowWaitingStatesByCorrelation,
  markExecutionCancelled,
  markExecutionRunning,
  markWaitingStatesCancelled,
  markWaitStateStatus,
} from "@/lib/workflow-wait-state";

// Validate API key and return the user ID if valid
async function validateApiKey(
  authHeader: string | null,
  workflowUserId: string
): Promise<{ valid: boolean; error?: string; statusCode?: number }> {
  if (!authHeader) {
    return {
      valid: false,
      error: "Missing Authorization header",
      statusCode: 401,
    };
  }

  // Support "Bearer <key>" format
  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!key?.startsWith("wfb_")) {
    return { valid: false, error: "Invalid API key format", statusCode: 401 };
  }

  // Hash the key to compare with stored hash
  const keyHash = createHash("sha256").update(key).digest("hex");

  // Find the API key in the database
  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!apiKey) {
    return { valid: false, error: "Invalid API key", statusCode: 401 };
  }

  // Verify the API key belongs to the workflow owner
  if (apiKey.userId !== workflowUserId) {
    return {
      valid: false,
      error: "You do not have permission to run this workflow",
      statusCode: 403,
    };
  }

  // Update last used timestamp (don't await, fire and forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .catch(() => {
      // Fire and forget - ignore errors
    });

  return { valid: true };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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
  workflowUserId: string;
  workflowNodes: WorkflowNode[];
  workflowEdges: WorkflowEdge[];
  payload: Record<string, unknown>;
  eventType?: string;
  correlationKey?: string;
  dryRun?: boolean;
}) {
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      userId: input.workflowUserId,
      status: "running",
      triggerType: "webhook",
      isDryRun: input.dryRun === true,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
    })
    .returning();

  const run = await start(executeWorkflow, [
    {
      nodes: input.workflowNodes,
      edges: input.workflowEdges,
      triggerInput: input.payload,
      executionId: execution.id,
      workflowId: input.workflowId,
      userId: input.workflowUserId,
      dryRun: input.dryRun === true,
      eventContext: {
        eventType: input.eventType,
        correlationKey: input.correlationKey,
      },
    },
  ]).catch(async (error) => {
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
      workflowRunId: run.runId,
    })
    .where(eq(workflowExecutions.id, execution.id));

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    userId: input.workflowUserId,
    executionId: execution.id,
    eventType: "run_started",
    message: `${input.dryRun ? "Webhook dry run started" : "Webhook run started"}${input.eventType ? ` for ${input.eventType}` : ""}`,
    metadata: {
      triggerType: "webhook",
      dryRun: input.dryRun === true,
      eventType: input.eventType,
      correlationKey: input.correlationKey,
      runId: run.runId,
    },
  });

  return {
    executionId: execution.id,
    runId: run.runId,
    dryRun: input.dryRun === true,
  };
}

async function cancelWaitingRuns(input: {
  workflowId: string;
  userId: string;
  waitStates: Array<{
    id: string;
    executionId: string;
    runId: string;
    nodeId: string;
    nodeName: string;
  }>;
  eventType?: string;
  reason: string;
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
      console.error(`[Webhook] Failed to cancel run ${runId}:`, error);
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

async function resumeMatchingWaitHooks(input: {
  workflowId: string;
  userId: string;
  eventType?: string;
  payload: Record<string, unknown>;
  waitStates: Array<{
    id: string;
    executionId: string;
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
      await resumeHook(waitState.hookToken, {
        eventType: input.eventType,
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
        userId: input.userId,
        eventType: "run_resumed",
        message: `Run resumed from wait on ${input.eventType}`,
        metadata: {
          eventType: input.eventType,
        },
      });

      resumedCount += 1;
    } catch (error) {
      console.error("[Webhook] Failed to resume hook:", error);
    }
  }

  return { resumedCount };
}

export function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Webhook orchestration requires branching for create/update/delete/resume flows
export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  try {
    const { workflowId } = await context.params;

    // Get workflow
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // Validate API key - must belong to the workflow owner
    const authHeader = request.headers.get("Authorization");
    const apiKeyValidation = await validateApiKey(authHeader, workflow.userId);

    if (!apiKeyValidation.valid) {
      return NextResponse.json(
        { error: apiKeyValidation.error },
        { status: apiKeyValidation.statusCode || 401, headers: corsHeaders }
      );
    }

    const workflowNodes = workflow.nodes as WorkflowNode[];

    // Verify this is a webhook-triggered workflow
    const triggerNode = getTriggerNode(workflowNodes);

    if (!triggerNode || triggerNode.data.config?.triggerType !== "Webhook") {
      return NextResponse.json(
        { error: "This workflow is not configured for webhook triggers" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate that all integrationIds in workflow nodes belong to the workflow owner
    const validation = await validateWorkflowIntegrations(
      workflowNodes,
      workflow.userId
    );
    if (!validation.valid) {
      console.error(
        "[Webhook] Invalid integration references:",
        validation.invalidIds
      );
      return NextResponse.json(
        { error: "Workflow contains invalid integration references" },
        { status: 403, headers: corsHeaders }
      );
    }

    const requestUrl = new URL(request.url);
    const dryRunFromQuery = parseBooleanFlag(
      requestUrl.searchParams.get("dryRun")
    );
    const dryRunFromHeader = parseBooleanFlag(
      request.headers.get("x-workflow-dry-run")
    );
    const dryRun = dryRunFromQuery ?? dryRunFromHeader ?? false;

    // Parse request body
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    const triggerConfig = triggerNode.data.config ?? {};
    const eventTypePath =
      asNonEmptyString(triggerConfig.webhookEventPath) ?? "event";
    const correlationPath =
      asNonEmptyString(triggerConfig.webhookCorrelationPath) ?? "data.id";

    const eventType = asNonEmptyString(getValueByPath(body, eventTypePath));
    const correlationKey = asNonEmptyString(
      getValueByPath(body, correlationPath)
    );

    await logWorkflowAuditEvent({
      workflowId,
      userId: workflow.userId,
      eventType: "trigger_received",
      message: `Webhook received${eventType ? `: ${eventType}` : ""}`,
      metadata: {
        eventType,
        correlationKey,
        dryRun,
      },
    });

    const createEvents = parseCsvSet(
      triggerConfig.webhookCreateEvents ?? "event.create"
    );
    const updateEvents = parseCsvSet(
      triggerConfig.webhookUpdateEvents ?? "event.update"
    );
    const deleteEvents = parseCsvSet(
      triggerConfig.webhookDeleteEvents ?? "event.delete"
    );

    if (dryRun) {
      const execution = await startWebhookExecution({
        workflowId,
        workflowUserId: workflow.userId,
        workflowNodes: workflow.nodes as WorkflowNode[],
        workflowEdges: workflow.edges as WorkflowEdge[],
        payload: body,
        eventType,
        correlationKey,
        dryRun: true,
      });

      return NextResponse.json(
        {
          executionId: execution.executionId,
          runId: execution.runId,
          status: "running",
          dryRun: true,
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

    if (eventType && deleteEvents.has(eventType)) {
      if (waitingStates.length === 0) {
        await logWorkflowAuditEvent({
          workflowId,
          userId: workflow.userId,
          eventType: "run_ignored",
          message: `Ignored ${eventType} because no waiting runs were found`,
          metadata: {
            eventType,
            correlationKey,
          },
        });

        return NextResponse.json(
          {
            status: "ignored",
            reason: "no_waiting_runs",
          },
          { headers: corsHeaders }
        );
      }

      const cancellation = await cancelWaitingRuns({
        workflowId,
        userId: workflow.userId,
        waitStates: waitingStates,
        eventType,
        reason: `Cancelled by webhook event ${eventType}`,
      });

      return NextResponse.json(
        {
          status: "cancelled",
          ...cancellation,
        },
        { headers: corsHeaders }
      );
    }

    if (eventType && updateEvents.has(eventType)) {
      if (waitingStates.length === 0) {
        await logWorkflowAuditEvent({
          workflowId,
          userId: workflow.userId,
          eventType: "run_ignored",
          message: `Ignored ${eventType} because no waiting runs were found`,
          metadata: {
            eventType,
            correlationKey,
          },
        });

        return NextResponse.json(
          {
            status: "ignored",
            reason: "no_waiting_runs",
          },
          { headers: corsHeaders }
        );
      }

      const cancellation = await cancelWaitingRuns({
        workflowId,
        userId: workflow.userId,
        waitStates: waitingStates,
        eventType,
        reason: `Cancelled by webhook event ${eventType}`,
      });

      const execution = await startWebhookExecution({
        workflowId,
        workflowUserId: workflow.userId,
        workflowNodes: workflow.nodes as WorkflowNode[],
        workflowEdges: workflow.edges as WorkflowEdge[],
        payload: body,
        eventType,
        correlationKey,
        dryRun,
      });

      return NextResponse.json(
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
      const resumed = await resumeMatchingWaitHooks({
        workflowId,
        userId: workflow.userId,
        eventType,
        payload: body,
        waitStates: waitingStates,
      });

      if (resumed.resumedCount > 0) {
        return NextResponse.json(
          {
            status: "resumed",
            resumedCount: resumed.resumedCount,
          },
          { headers: corsHeaders }
        );
      }
    }

    // Event types not configured to create runs are ignored.
    if (eventType && createEvents.size > 0 && !createEvents.has(eventType)) {
      await logWorkflowAuditEvent({
        workflowId,
        userId: workflow.userId,
        eventType: "run_ignored",
        message: `Ignored webhook event ${eventType}`,
        metadata: {
          eventType,
          correlationKey,
        },
      });

      return NextResponse.json(
        {
          status: "ignored",
          reason: "event_not_configured",
        },
        { headers: corsHeaders }
      );
    }

    const execution = await startWebhookExecution({
      workflowId,
      workflowUserId: workflow.userId,
      workflowNodes: workflow.nodes as WorkflowNode[],
      workflowEdges: workflow.edges as WorkflowEdge[],
      payload: body,
      eventType,
      correlationKey,
      dryRun,
    });

    return NextResponse.json(
      {
        executionId: execution.executionId,
        runId: execution.runId,
        status: "running",
        dryRun,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("[Webhook] Failed to start workflow execution:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to execute workflow",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
