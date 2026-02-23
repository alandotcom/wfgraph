import { sendWorkflowWaitSignal } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  markExecutionRunning,
  markWaitStateStatus,
} from "@/backend/lib/workflow-wait-state";

const logger = getAppLogger("workflow", "wait-resume");

export async function resumeMatchingWaitHooks(input: {
  workflowId: string;
  eventType?: string;
  payload: Record<string, unknown>;
  waitStates: Array<{
    id: string;
    executionId: string;
    nodeId: string;
    hookToken: string | null;
    metadata: Record<string, unknown> | null;
  }>;
}) {
  if (!input.eventType) {
    return 0;
  }

  const resumeResults = await Promise.all(
    input.waitStates.map(async (waitState) => {
      if (!waitState.hookToken) {
        return 0;
      }

      const metadata = waitState.metadata ?? {};

      try {
        await sendWorkflowWaitSignal({
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          token: waitState.hookToken,
          eventType: input.eventType,
          correlationKey:
            typeof metadata.correlationKey === "string"
              ? metadata.correlationKey
              : undefined,
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
            message: `Run resumed from wait on ${input.eventType}`,
            metadata: {
              eventType: input.eventType,
            },
          }),
        ]);

        return 1;
      } catch (error) {
        logger.error("Failed to resume hook", {
          workflowId: input.workflowId,
          eventType: input.eventType,
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
