import type {
  WorkflowExecutionCancelledResponse,
  WorkflowExecutionIgnoredResponse,
  WorkflowExecutionResumedResponse,
  WorkflowExecutionRunningResponse,
} from "@rova/shared/workflow/execution-contracts";
import type { ResolvedTriggerRouting } from "@rova/shared/workflow/routing-policy";

export type TriggerWaitState = {
  id: string;
  executionId: string;
  nodeId: string;
  hookToken: string | null;
  metadata: Record<string, unknown> | null;
};

type CancellationSummary = {
  cancelledExecutions: number;
  cancelledWaits: number;
  failedExecutions?: string[];
};

type TriggerOrchestratorInput = {
  runMode: "live" | "test";
  routing: ResolvedTriggerRouting;
  /** Every in-flight execution for the correlation key. */
  inFlightExecutionIds: string[];
  /** Wait states for the waiting subset of those executions. */
  waitStates: TriggerWaitState[];
  enableResumes: boolean;
  startExecution: () => Promise<{
    executionId: string;
    runId?: string;
    runMode: "live" | "test";
  }>;
  cancelInFlightRuns: (eventType?: string) => Promise<CancellationSummary>;
  resumeWaitStates: (
    eventType: string,
    waitStates: TriggerWaitState[]
  ) => Promise<number>;
};

export type TriggerOrchestratorResult =
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionIgnoredResponse
  | WorkflowExecutionResumedResponse;

async function handleCancelOrReplace(
  input: TriggerOrchestratorInput
): Promise<
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionIgnoredResponse
  | undefined
> {
  const { routing } = input;
  if (routing.action !== "cancel" && routing.action !== "replace") {
    return undefined;
  }

  if (input.inFlightExecutionIds.length === 0) {
    if (routing.action === "cancel") {
      return {
        status: "ignored",
        runMode: input.runMode,
        reason: "no_in_flight_runs",
      };
    }
    // replace with nothing running → fall through to start a new execution
    return undefined;
  }

  if (routing.action === "cancel") {
    return {
      status: "cancelled",
      runMode: input.runMode,
      ...(await input.cancelInFlightRuns(routing.eventType)),
    };
  }

  const cancellationSummary = await input.cancelInFlightRuns(routing.eventType);
  const execution = await input.startExecution();
  return {
    status: "running",
    executionId: execution.executionId,
    runId: execution.runId,
    runMode: execution.runMode,
    ...cancellationSummary,
  };
}

async function handleResumes(
  input: TriggerOrchestratorInput
): Promise<WorkflowExecutionResumedResponse | undefined> {
  if (!input.enableResumes) {
    return undefined;
  }

  const { eventType, correlationKey } = input.routing;
  if (!(eventType && correlationKey) || input.waitStates.length === 0) {
    return undefined;
  }

  // Which waits an event wakes is resume matching's own knowledge; a zero
  // return means nothing matched and costs nothing, so there is no
  // pre-count here to drift from the real predicate.
  const resumedCount = await input.resumeWaitStates(
    eventType,
    input.waitStates
  );
  if (resumedCount > 0) {
    return {
      status: "resumed",
      resumedCount,
      runMode: input.runMode,
    };
  }

  return undefined;
}

/**
 * Acts on a resolved routing action. Ordering carries two deliberate rules:
 * the policy wins over waits (a cancel/replace kills waiting runs before
 * resume matching ever sees the event), and a resume wins over start (an
 * Event Type mapped to Start that a waiting run is listening for wakes that
 * run instead of starting a new one — the waiting run consumes the event).
 * An ignored event still reaches resume matching, which is the sanctioned
 * way to express "this event only wakes waits".
 */
export async function orchestrateTriggerExecution(
  input: TriggerOrchestratorInput
): Promise<TriggerOrchestratorResult> {
  const { routing } = input;

  if (
    routing.action === "ignore" &&
    (routing.ignoreReason === "invalid_payload" ||
      routing.ignoreReason === "missing_event_type")
  ) {
    return {
      status: "ignored",
      runMode: input.runMode,
      reason: routing.ignoreReason,
    };
  }

  const cancelOrReplaceOutcome = await handleCancelOrReplace(input);
  if (cancelOrReplaceOutcome) {
    return cancelOrReplaceOutcome;
  }

  const resumeOutcome = await handleResumes(input);
  if (resumeOutcome) {
    return resumeOutcome;
  }

  if (routing.action === "ignore") {
    return {
      status: "ignored",
      runMode: input.runMode,
      reason: routing.ignoreReason,
    };
  }

  const execution = await input.startExecution();
  return {
    status: "running",
    executionId: execution.executionId,
    runId: execution.runId,
    runMode: execution.runMode,
  };
}
