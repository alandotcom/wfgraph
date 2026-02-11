import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { logWorkflowAuditEvent } from "@/lib/workflow-audit";
import { executeWorkflow } from "@/lib/workflow-executor.workflow";
import type { WorkflowNode } from "@/lib/workflow-store";

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
    const input = body.input ?? {};
    const dryRun = body.dryRun === true;

    // Create execution record
    const [execution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId,
        userId: session.user.id,
        status: "running",
        triggerType: "manual",
        isDryRun: dryRun,
        input,
      })
      .returning();

    const run = await start(executeWorkflow, [
      {
        nodes: workflow.nodes,
        edges: workflow.edges,
        triggerInput: input,
        executionId: execution.id,
        workflowId,
        userId: session.user.id,
        dryRun,
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
        triggerType: "manual",
        dryRun,
        runId: run.runId,
      },
    });

    // Return immediately with the execution ID
    return NextResponse.json({
      executionId: execution.id,
      runId: run.runId,
      status: "running",
      dryRun,
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
