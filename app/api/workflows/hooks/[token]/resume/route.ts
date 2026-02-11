import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiKeys, workflowWaitStates } from "@/lib/db/schema";
import { sendWorkflowWaitSignal } from "@/lib/inngest/runtime-events";
import { logWorkflowAuditEvent } from "@/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "@/lib/workflow-wait-state";

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

  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!key?.startsWith("wfb_")) {
    return { valid: false, error: "Invalid API key format", statusCode: 401 };
  }

  const keyHash = createHash("sha256").update(key).digest("hex");

  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!apiKey) {
    return { valid: false, error: "Invalid API key", statusCode: 401 };
  }

  if (apiKey.userId !== workflowUserId) {
    return {
      valid: false,
      error: "You do not have permission to resume this workflow",
      statusCode: 403,
    };
  }

  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .catch(() => {
      // Ignore non-blocking telemetry update failures
    });

  return { valid: true };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;

    const waitState = await db.query.workflowWaitStates.findFirst({
      where: and(
        eq(workflowWaitStates.hookToken, token),
        eq(workflowWaitStates.status, "waiting")
      ),
    });

    if (!waitState) {
      return NextResponse.json(
        { error: "Wait hook not found or no longer active" },
        { status: 404 }
      );
    }

    const apiKeyValidation = await validateApiKey(
      request.headers.get("Authorization"),
      waitState.userId
    );

    if (!apiKeyValidation.valid) {
      return NextResponse.json(
        { error: apiKeyValidation.error },
        { status: apiKeyValidation.statusCode || 401 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    await sendWorkflowWaitSignal({
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
      token,
      payload: body,
    });

    await markWaitStateStatus({
      waitStateId: waitState.id,
      status: "resumed",
    });
    await markExecutionRunning(waitState.executionId);

    await logWorkflowAuditEvent({
      workflowId: waitState.workflowId,
      executionId: waitState.executionId,
      userId: waitState.userId,
      eventType: "run_resumed",
      message: "Run resumed from external hook endpoint",
      metadata: {
        token,
      },
    });

    return NextResponse.json({
      success: true,
      status: "resumed",
      executionId: waitState.executionId,
    });
  } catch (error) {
    console.error("Failed to resume wait hook:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to resume wait hook",
      },
      { status: 500 }
    );
  }
}
