/**
 * Ending a run from outside it, which happens two ways and in two orders.
 *
 * A cancel decides and then acts: the signal goes out, the row flips behind a
 * compare-and-set, and a run that finished first keeps its own terminal status. A
 * supersede has already been decided -- `ExecutionRepo.startForEntity` flips those
 * rows inside the lock that made room for the newer start -- so all that is left
 * is telling the runs to stop and saying why on their timelines.
 *
 * Either way a run can outlive the attempt: a signal that does not land leaves it
 * live against a terminal row, and both halves below report the ids that happened
 * to.
 */

import { partition, uniq } from "es-toolkit";
import { getAppLogger } from "#src/backend/lib/logger";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import {
  endInFlightExecution,
  markWaitingStatesCancelled,
} from "#src/backend/lib/workflow-wait-state";

const logger = getAppLogger("workflow", "run-ending");

/** A wait row belonging to a run being ended, which is cancelled with it. */
type EndingWaitState = {
  id: string;
  executionId: string;
};

/**
 * Asking Inngest to stop one run, as the caller's own send.
 *
 * A port rather than an import: this module mixes the send with the wait-state
 * bookkeeping around it, so it sits below the `InngestClient` service its caller
 * holds and takes the one send it needs from there.
 */
export type RequestRunCancel = (input: {
  executionId: string;
  workflowId: string;
  reason: string;
  requestedBy: string;
  eventType?: string;
}) => Promise<void>;

export type CancelInFlightRunsInput = {
  requestCancel: RequestRunCancel;
  workflowId: string;
  /** Every in-flight execution to end, whatever node each is standing on. */
  executionIds: string[];
  /** Wait states belonging to the waiting subset of those executions. */
  waitStates: EndingWaitState[];
  reason: string;
  eventName?: string;
};

export type EndedRunsSummary = {
  /** The runs this call ended, which are the runs an event no longer reaches. */
  endedExecutionIds: string[];
  /** The runs no signal reached, which may still be live against a dead row. */
  failedExecutionIds: string[];
};

/**
 * Sends one run's cancel signal, and says on its timeline when the send failed.
 *
 * Each workflow function's `cancelOn` stops the run between steps and interrupts
 * sleeps and waits; a step already executing runs to completion, which is why
 * every completion write carries its own terminal-status guard. The signal for a
 * run that has already finished is a no-op at Inngest.
 */
async function signalRunToStop(input: {
  requestCancel: RequestRunCancel;
  workflowId: string;
  executionId: string;
  reason: string;
  eventName?: string;
}): Promise<boolean> {
  try {
    await input.requestCancel({
      executionId: input.executionId,
      workflowId: input.workflowId,
      reason: input.reason,
      requestedBy: input.workflowId,
      eventType: input.eventName,
    });
    return true;
  } catch (error) {
    logger.error("Failed to send cancel signal for execution", {
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventName: input.eventName,
      error,
    });

    await recordEndingFailure({
      workflowId: input.workflowId,
      executionId: input.executionId,
      message: `${input.reason}: the cancel signal failed to send, so the run may still be live`,
      eventName: input.eventName,
      outcome: "send_failed",
    });

    return false;
  }
}

/**
 * Says on a run's timeline that an ending went half-through.
 *
 * The run survives either half-failure, so without this row a run left live
 * against a stale status reads as a healthy one. The write itself is allowed to
 * fail: a `write_failed` outcome means the database just refused a write, and the
 * log line is what an operator has left in that case.
 */
async function recordEndingFailure(input: {
  workflowId: string;
  executionId: string;
  message: string;
  eventName?: string;
  outcome: "send_failed" | "write_failed";
}): Promise<void> {
  try {
    await logWorkflowAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: "run_cancel_requested",
      message: input.message,
      metadata: { eventName: input.eventName, outcome: input.outcome },
    });
  } catch (auditError) {
    logger.error("Failed to record a half-failed ending", {
      workflowId: input.workflowId,
      executionId: input.executionId,
      outcome: input.outcome,
      error: auditError,
    });
  }
}

async function recordRunEnded(input: {
  workflowId: string;
  executionId: string;
  eventType: "run_cancelled" | "run_superseded";
  reason: string;
  eventName?: string;
}): Promise<boolean> {
  try {
    await logWorkflowAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: input.eventType,
      message: input.reason,
      metadata: { eventName: input.eventName },
    });
    return true;
  } catch (error) {
    logger.error("Failed to record the end of an execution", {
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventName: input.eventName,
      error,
    });
    return false;
  }
}

/**
 * Cancels every in-flight execution named: signal first, then the row behind a
 * compare-and-set.
 *
 * An execution that completed between the caller's candidate query and this write
 * loses nothing: the CAS fails, the row keeps its terminal status, no audit event
 * is written, and the run is not counted as ended. Its wait row is still cleaned,
 * because a prior partly-failed attempt can leave a terminal execution with a
 * still-waiting row and this is the path that heals it
 * (`markWaitingStatesCancelled` guards on `waiting`, so a legitimately resumed
 * wait is untouched).
 *
 * Every await is contained per execution, so one failure never discards the
 * summary or skips the cleanup for the executions that did end.
 */
export async function cancelInFlightRuns(
  input: CancelInFlightRunsInput
): Promise<EndedRunsSummary> {
  const outcomes = await Promise.all(
    uniq(input.executionIds).map(async (executionId) => {
      const signalled = await signalRunToStop({
        requestCancel: input.requestCancel,
        workflowId: input.workflowId,
        executionId,
        reason: input.reason,
        eventName: input.eventName,
      });
      if (!signalled) {
        return { executionId, ended: false, failed: true };
      }

      let wasInFlight: boolean;
      try {
        wasInFlight = await endInFlightExecution({
          executionId,
          status: "canceled",
          error: input.reason,
        });
      } catch (error) {
        logger.error("Failed to end an execution", {
          workflowId: input.workflowId,
          executionId,
          error,
        });
        await recordEndingFailure({
          workflowId: input.workflowId,
          executionId,
          message: `${input.reason}: the run was told to stop, but its status could not be written`,
          eventName: input.eventName,
          outcome: "write_failed",
        });
        return { executionId, ended: false, failed: true };
      }

      if (!wasInFlight) {
        logger.info(
          "Execution reached a terminal status before it could be ended",
          { workflowId: input.workflowId, executionId }
        );
        return { executionId, ended: false, failed: false };
      }

      const recorded = await recordRunEnded({
        workflowId: input.workflowId,
        executionId,
        eventType: "run_cancelled",
        reason: input.reason,
        eventName: input.eventName,
      });
      return { executionId, ended: recorded, failed: !recorded };
    })
  );

  const [failed, settled] = partition(outcomes, (entry) => entry.failed);

  await markWaitingStatesCancelled(
    waitStateIdsFor(
      input.waitStates,
      settled.map((entry) => entry.executionId)
    )
  );

  return {
    endedExecutionIds: settled
      .filter((entry) => entry.ended)
      .map((entry) => entry.executionId),
    failedExecutionIds: failed.map((entry) => entry.executionId),
  };
}

/**
 * Tells the runs a newer start displaced to stop, and records what ended them.
 *
 * Their execution rows and wait rows were both flipped inside the lock that made
 * room for the newer start, so there is no compare-and-set here and no wait row to
 * clean: this is the announcement half of a decision already made.
 */
export async function announceSupersededRuns(input: {
  requestCancel: RequestRunCancel;
  workflowId: string;
  executionIds: string[];
  reason: string;
  eventName?: string;
}): Promise<{ failedExecutionIds: string[] }> {
  const outcomes = await Promise.all(
    uniq(input.executionIds).map(async (executionId) => {
      const signalled = await signalRunToStop({
        requestCancel: input.requestCancel,
        workflowId: input.workflowId,
        executionId,
        reason: input.reason,
        eventName: input.eventName,
      });
      const recorded = await recordRunEnded({
        workflowId: input.workflowId,
        executionId,
        eventType: "run_superseded",
        reason: input.reason,
        eventName: input.eventName,
      });

      return { executionId, failed: !(signalled && recorded) };
    })
  );

  return {
    failedExecutionIds: outcomes
      .filter((entry) => entry.failed)
      .map((entry) => entry.executionId),
  };
}

function waitStateIdsFor(
  waitStates: EndingWaitState[],
  executionIds: string[]
): string[] {
  const ended = new Set(executionIds);
  return waitStates
    .filter((state) => ended.has(state.executionId))
    .map((state) => state.id);
}
