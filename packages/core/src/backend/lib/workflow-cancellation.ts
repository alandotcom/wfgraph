import { partition, uniq } from "es-toolkit";
import { sendWorkflowCancelRequested } from "@/backend/lib/inngest/runtime-events";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/backend/lib/workflow-wait-state";

type CancellationLogger = {
  error: (message: string, properties?: Record<string, unknown>) => void;
  info: (message: string, properties?: Record<string, unknown>) => void;
};

export type CancelInFlightRunsInput = {
  workflowId: string;
  /** Every in-flight execution for the correlation key, whatever its node. */
  executionIds: string[];
  /** Wait states belonging to the waiting subset of those executions. */
  waitStates: Array<{
    id: string;
    executionId: string;
  }>;
  reason: string;
  eventType?: string;
  logger: CancellationLogger;
};

export type CancelInFlightRunsSummary = {
  cancelledExecutions: number;
  cancelledWaits: number;
  failedExecutions?: string[];
};

type ExecutionCancelOutcome =
  | "cancelled"
  | "lost_race"
  | "send_failed"
  | "write_failed";

/**
 * Cancels every in-flight execution a Replace/Cancel routing action names.
 * Per execution: the Inngest cancel event goes out first (each workflow
 * function's `cancelOn` stops the run between steps and interrupts sleeps
 * and waits; a step already executing runs to completion, which is why the
 * completion write carries its own terminal-status guard), then the row
 * flips to cancelled behind a compare-and-set. An execution that completed
 * between the caller's candidate query and this write loses nothing: the
 * CAS fails, the row keeps its terminal status, no audit event is written,
 * and the run is not counted. The cancel event for a finished run is a
 * no-op at Inngest.
 *
 * Every await is contained per execution, so one failure never discards the
 * batch's summary or skips the wait-state cleanup for executions that did
 * cancel. Wait states are also cleaned for `lost_race` executions: a prior
 * partially-failed invocation can leave a terminal execution with a
 * still-waiting row, and this is the retry path that heals it
 * (`markWaitingStatesCancelled` CAS-guards on `waiting`, so rows of
 * legitimately resumed waits are untouched).
 */
export async function cancelInFlightRuns(
  input: CancelInFlightRunsInput
): Promise<CancelInFlightRunsSummary> {
  const outcomes = await Promise.all(
    uniq(input.executionIds).map(
      async (
        executionId
      ): Promise<{ executionId: string; outcome: ExecutionCancelOutcome }> => {
        try {
          await sendWorkflowCancelRequested({
            executionId,
            workflowId: input.workflowId,
            reason: input.reason,
            requestedBy: input.workflowId,
            eventType: input.eventType,
          });
        } catch (error) {
          input.logger.error("Failed to send cancel signal for execution", {
            workflowId: input.workflowId,
            executionId,
            eventType: input.eventType,
            error,
          });
          // The run survives a lost cancel, so the timeline must say the
          // policy tried: without this row, a Replace that half-failed
          // reads as two healthy runs.
          try {
            await logWorkflowAuditEvent({
              workflowId: input.workflowId,
              executionId,
              eventType: "run_cancel_requested",
              message: `${input.reason} — cancel signal failed to send; the run may still be live`,
              metadata: {
                eventType: input.eventType,
                outcome: "send_failed",
              },
            });
          } catch (auditError) {
            input.logger.error("Failed to record cancel-failure audit event", {
              workflowId: input.workflowId,
              executionId,
              error: auditError,
            });
          }
          return { executionId, outcome: "send_failed" };
        }

        try {
          const wasInFlight = await markExecutionCancelled({
            executionId,
            error: input.reason,
          });
          if (!wasInFlight) {
            input.logger.info(
              "Execution reached a terminal status before the policy cancel",
              {
                workflowId: input.workflowId,
                executionId,
                eventType: input.eventType,
              }
            );
            return { executionId, outcome: "lost_race" };
          }

          await logWorkflowAuditEvent({
            workflowId: input.workflowId,
            executionId,
            eventType: "run_cancelled",
            message: input.reason,
            metadata: {
              eventType: input.eventType,
            },
          });
          return { executionId, outcome: "cancelled" };
        } catch (error) {
          input.logger.error("Failed to record execution cancellation", {
            workflowId: input.workflowId,
            executionId,
            eventType: input.eventType,
            error,
          });
          return { executionId, outcome: "write_failed" };
        }
      }
    )
  );

  const [failed, settled] = partition(
    outcomes,
    (entry) =>
      entry.outcome === "send_failed" || entry.outcome === "write_failed"
  );
  const cancelledExecutionIds = new Set(
    settled
      .filter((entry) => entry.outcome === "cancelled")
      .map((entry) => entry.executionId)
  );
  const settledExecutionIds = new Set(
    settled.map((entry) => entry.executionId)
  );

  const waitStateIdsToCancel = input.waitStates
    .filter((state) => settledExecutionIds.has(state.executionId))
    .map((state) => state.id);
  const cancelledWaitStateIds =
    await markWaitingStatesCancelled(waitStateIdsToCancel);

  return {
    cancelledExecutions: cancelledExecutionIds.size,
    cancelledWaits: cancelledWaitStateIds.length,
    failedExecutions:
      failed.length > 0 ? failed.map((entry) => entry.executionId) : undefined,
  };
}
