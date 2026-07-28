import type { JsonObject } from "@rova/shared/types/json";
import { and, eq } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import { workflowWaitStates } from "#src/backend/lib/db/schema";
import { responseFromServiceResult } from "#src/backend/lib/http/response-from-service-result";
import { sendWorkflowWaitSignal } from "#src/backend/lib/inngest/runtime-events";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "#src/backend/lib/workflow-wait-state";
import { type RovaRuntime, runToServiceResult } from "#src/backend/runtime";
import { validateApiKey } from "#src/backend/services/api-keys/auth";
import { getErrorMessage } from "@rova/shared/utils";

const workflowResumeLogger = getAppLogger("workflow", "resume");

type WorkflowResumeSuccess = {
  success: true;
  status: "resumed";
  executionId: string;
};

type WorkflowResumeError = { error: string };

export async function postWorkflowResumeResult(
  token: string,
  body: JsonObject,
  authHeader: string | null,
  /**
   * The app's Effect runtime, needed because API key verification has moved to
   * Effect while this service has not. Stage 3b of the Effect migration turns
   * this function into an Effect of its own, at which point it asks for its
   * services the way `validateApiKey` does and this parameter goes away.
   */
  runtime: RovaRuntime
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

    const apiKeyValidation = await runToServiceResult(
      runtime,
      validateApiKey(authHeader)
    );

    if (!apiKeyValidation.ok) {
      requestLogger.warn("Workflow resume rejected due to invalid API key", {
        reason: apiKeyValidation.error.error,
      });
      return apiKeyValidation;
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
  body: JsonObject,
  authHeader: string | null,
  runtime: RovaRuntime
) {
  return responseFromServiceResult(
    await postWorkflowResumeResult(token, body, authHeader, runtime)
  );
}
