import { and, eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowWaitStates } from "@/backend/lib/db/schema";
import { sendWorkflowWaitSignal } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";
import { validateApiKey } from "@/backend/services/api-keys/auth.api-keys";

const workflowResumeLogger = getAppLogger("workflow", "resume");

export async function postWorkflowResume(
  token: string,
  body: Record<string, unknown>,
  authHeader: string | null
) {
  const requestLogger = workflowResumeLogger.with({
    token,
  });
  try {
    const waitState = await db.query.workflowWaitStates.findFirst({
      where: and(
        eq(workflowWaitStates.hookToken, token),
        eq(workflowWaitStates.status, "waiting")
      ),
    });

    if (!waitState) {
      requestLogger.warn("Wait hook not found or no longer active");
      return Response.json(
        { error: "Wait hook not found or no longer active" },
        { status: 404 }
      );
    }

    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      requestLogger.warn("Workflow resume rejected due to invalid API key", {
        statusCode: apiKeyValidation.statusCode ?? 401,
      });
      return Response.json(
        { error: apiKeyValidation.error },
        { status: apiKeyValidation.statusCode || 401 }
      );
    }

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
      eventType: "run_resumed",
      message: "Run resumed from external hook endpoint",
      metadata: {
        token,
      },
    });

    return Response.json({
      success: true,
      status: "resumed",
      executionId: waitState.executionId,
    });
  } catch (error) {
    requestLogger.error("Failed to resume wait hook", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to resume wait hook",
      },
      { status: 500 }
    );
  }
}
