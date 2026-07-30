import type { JsonObject } from "@rova/shared/types/json";
import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import { sendWorkflowWaitSignal } from "#src/backend/lib/inngest/runtime-events";
import { getAppLogger } from "#src/backend/lib/logger";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "#src/backend/lib/workflow-wait-state";
import { readCompiledWaitSubscriptions } from "#src/backend/lib/workflow-engine/wait-match";

const logger = getAppLogger("workflow", "wait-resume");

type CandidateWaitState = {
  id: string;
  executionId: string;
  nodeId: string;
  resumeToken: string | null;
  subscribedEvents: string[] | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Whether this arrival is one this row parked for.
 *
 * The row's own subscriptions decide, not the node's current ones: the node may
 * name different Events by now, and the run is owed what it waited for. A
 * subscription with no expression resumes on the next occurrence of its Event,
 * which is what the editor says a match-free subscription means.
 *
 * An expression that fails to evaluate does not wake the run. The payload
 * arrived from outside and may carry anything, so a field of the wrong type is a
 * payload that does not satisfy the match rather than a reason to resume.
 */
function waitStateMatches(input: {
  waitState: CandidateWaitState;
  eventType: string;
  payload: JsonObject;
}): boolean {
  const subscriptions = readCompiledWaitSubscriptions(
    input.waitState.metadata
  ).filter((subscription) => subscription.event === input.eventType);

  return subscriptions.some((subscription) => {
    if (!subscription.match) {
      return true;
    }

    const evaluation = evaluateCompiledCondition({
      ...subscription.match,
      payload: input.payload,
    });

    if (!evaluation.ok) {
      logger.warn("Wait match did not evaluate", {
        eventType: input.eventType,
        waitStateId: input.waitState.id,
        error: evaluation.error,
      });
      return false;
    }

    return evaluation.value;
  });
}

export async function resumeWaitsMatchingEvent(input: {
  workflowId: string;
  eventType?: string;
  payload: JsonObject;
  waitStates: CandidateWaitState[];
}) {
  const { eventType } = input;
  if (!eventType) {
    return 0;
  }

  const resumeResults = await Promise.all(
    input.waitStates.map(async (waitState) => {
      const resumeToken = waitState.resumeToken;
      if (!resumeToken) {
        return 0;
      }

      if (!waitStateMatches({ waitState, eventType, payload: input.payload })) {
        return 0;
      }

      try {
        await sendWorkflowWaitSignal({
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          token: resumeToken,
          eventType,
          payload: input.payload,
        });

        const waitStateUpdated = await markWaitStateStatus({
          waitStateId: waitState.id,
          status: "resumed",
        });

        if (!waitStateUpdated) {
          return 0;
        }

        await Promise.all([
          markExecutionRunning(waitState.executionId),
          logWorkflowAuditEvent({
            workflowId: input.workflowId,
            executionId: waitState.executionId,
            eventType: "run_resumed",
            message: `Run resumed from wait on ${eventType}`,
            metadata: {
              eventType,
            },
          }),
        ]);

        return 1;
      } catch (error) {
        logger.error("Failed to resume wait", {
          workflowId: input.workflowId,
          eventType,
          waitStateId: waitState.id,
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          error,
        });
        return 0;
      }
    })
  );

  return resumeResults.reduce<number>((total, count) => total + count, 0);
}
