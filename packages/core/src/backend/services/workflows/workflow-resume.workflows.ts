import { and, eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowWaitStates } from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import { sendWorkflowWaitSignal } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";
import { validateApiKey } from "@/backend/services/api-keys/auth.api-keys";
import { getErrorMessage } from "@/shared/utils";

const workflowResumeLogger = getAppLogger("workflow", "resume");

type WorkflowResumeSuccess = {
  success: true;
  status: "resumed";
  executionId: string;
};

type WorkflowResumeError = { error: string };

export async function postWorkflowResumeResult(
  token: string,
  body: Record<string, unknown>,
  authHeader: string | null
): Promise<
  ServiceResult<
    WorkflowResumeSuccess,
    "invalid" | "unauthorized" | "not_found" | "conflict" | "internal",
    WorkflowResumeError
  >
> {
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
      return failure("not_found", {
        error: "Wait hook not found or no longer active",
      });
    }

    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      requestLogger.warn("Workflow resume rejected due to invalid API key", {
        reason: apiKeyValidation.error,
      });
      return failure("unauthorized", {
        error: apiKeyValidation.error,
      });
    }

    await sendWorkflowWaitSignal({
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
      token,
      payload: body,
    });

    const waitStateUpdated = await markWaitStateStatus({
      waitStateId: waitState.id,
      status: "resumed",
    });
    if (!waitStateUpdated) {
      requestLogger.warn("Wait hook changed state before resume update");
      return failure("conflict", {
        error: "Wait hook not found or no longer active",
      });
    }

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

    return success({
      success: true,
      status: "resumed",
      executionId: waitState.executionId,
    });
  } catch (error) {
    requestLogger.error(
      `Failed to resume wait hook: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to resume wait hook",
    });
  }
}

export async function postWorkflowResume(
  token: string,
  body: Record<string, unknown>,
  authHeader: string | null
) {
  return responseFromServiceResult(
    await postWorkflowResumeResult(token, body, authHeader)
  );
}
