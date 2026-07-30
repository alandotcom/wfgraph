import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import { statedSeamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { Conflict, NotFound } from "#src/backend/lib/effect/failures";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "#src/backend/lib/workflow-wait-state";
import { validateApiKey } from "#src/backend/services/api-keys/auth";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";
import type { JsonObject } from "@rova/shared/types/json";

type WorkflowResumeSuccess = {
  success: true;
  status: "resumed";
  executionId: string;
};

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (token: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "resume").with({ token })
  );

export const postWorkflowResume = Effect.fn("postWorkflowResume")(
  function* (input: {
    token: string;
    body: JsonObject;
    authHeader: string | null;
  }) {
    const { token, body, authHeader } = input;
    const repo = yield* ExecutionRepo;
    const inngest = yield* InngestClient;
    const logger = yield* loggerFor(token);

    // Credentials before the lookup, the ordering event intake uses too. A wait
    // token travels in a URL and so accumulates in browser history, proxy logs,
    // and referrers; answering "not found" versus "unauthorized" to a caller who
    // has one but no API key tells them whether that token is still live.
    yield* validateApiKey(authHeader).pipe(
      Effect.tapError((failure) =>
        logger.warn("Workflow resume rejected due to invalid API key", {
          reason: failure.payload.error,
        })
      )
    );

    const waitState = yield* repo.findWaitingStateByToken(token);

    if (!waitState) {
      yield* logger.warn("Wait hook not found or no longer active");
      return yield* Effect.fail(
        new NotFound({ error: "Wait hook not found or no longer active" })
      );
    }

    yield* inngest.sendWaitSignal({
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
      token,
      payload: body,
    });

    const waitStateUpdated = yield* callDbModule(() =>
      markWaitStateStatus({ waitStateId: waitState.id, status: "resumed" })
    );
    if (!waitStateUpdated) {
      yield* logger.warn("Wait hook changed state before resume update");
      return yield* Effect.fail(
        new Conflict({ error: "Wait hook not found or no longer active" })
      );
    }

    yield* callDbModule(() => markExecutionRunning(waitState.executionId));

    yield* callDbModule(() =>
      logWorkflowAuditEvent({
        workflowId: waitState.workflowId,
        executionId: waitState.executionId,
        eventType: "run_resumed",
        message: "Run resumed from external hook endpoint",
        metadata: {
          token,
        },
      })
    );

    const resumed: WorkflowResumeSuccess = {
      success: true,
      status: "resumed",
      executionId: waitState.executionId,
    };
    return resumed;
  },
  (effect, input) =>
    // A machine route across origins: the caller holds a resume token, not our
    // confidence, so the cause goes to the log and they get a stated sentence.
    effect.pipe(
      Effect.catchTags(
        statedSeamFailureHandlers(
          loggerFor(input.token),
          "Failed to resume wait hook",
          "Could not resume this wait"
        )
      )
    )
);
