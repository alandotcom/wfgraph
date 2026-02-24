import { parseCsvSet } from "@/shared/utils/object-path";
import type {
  WorkflowExecutionCancelledResponse,
  WorkflowExecutionIgnoredResponse,
  WorkflowExecutionResumedResponse,
  WorkflowExecutionRunningResponse,
} from "@/shared/workflow/execution-contracts";
import type { TriggerRoutingDecision } from "@/shared/workflow/trigger-registry";

type TriggerWaitState = {
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
  eventType?: string;
  correlationKey?: string;
  routingDecision: TriggerRoutingDecision;
  waitStates: TriggerWaitState[];
  enableResumes: boolean;
  startExecution: () => Promise<{
    executionId: string;
    runId?: string;
    runMode: "live" | "test";
  }>;
  cancelWaitStates: (eventType?: string) => Promise<CancellationSummary>;
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

function countResumableWaitStates(
  waitStates: TriggerWaitState[],
  eventType: string
): number {
  return waitStates.filter((waitState) => {
    if (!waitState.hookToken) {
      return false;
    }

    const metadata = waitState.metadata ?? {};
    const waitForEvents = parseCsvSet(metadata.waitForEvents);
    return waitForEvents.size === 0 || waitForEvents.has(eventType);
  }).length;
}

async function handleStopOrRestart(
  input: TriggerOrchestratorInput
): Promise<
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionIgnoredResponse
  | undefined
> {
  if (
    input.routingDecision.kind !== "stop" &&
    input.routingDecision.kind !== "restart"
  ) {
    return;
  }

  if (input.waitStates.length === 0) {
    return {
      status: "ignored",
      runMode: input.runMode,
      reason: "no_waiting_runs",
    };
  }

  if (input.routingDecision.kind === "stop") {
    return {
      status: "cancelled",
      runMode: input.runMode,
      ...(await input.cancelWaitStates(input.eventType)),
    };
  }

  const cancellationSummary = await input.cancelWaitStates(input.eventType);
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
    return;
  }

  if (
    !(input.eventType && input.correlationKey) ||
    input.waitStates.length === 0
  ) {
    return;
  }

  const resumableCount = countResumableWaitStates(
    input.waitStates,
    input.eventType
  );
  if (resumableCount === 0) {
    return;
  }

  const resumedCount = await input.resumeWaitStates(
    input.eventType,
    input.waitStates
  );
  if (resumedCount > 0) {
    return {
      status: "resumed",
      resumedCount,
      runMode: input.runMode,
    };
  }

  return;
}

export async function orchestrateTriggerExecution(
  input: TriggerOrchestratorInput
): Promise<TriggerOrchestratorResult> {
  if (
    input.routingDecision.kind === "ignore" &&
    input.routingDecision.reason === "missing_event_type"
  ) {
    return {
      status: "ignored",
      runMode: input.runMode,
      reason: "missing_event_type",
    };
  }

  const stopOrRestartOutcome = await handleStopOrRestart(input);
  if (stopOrRestartOutcome) {
    return stopOrRestartOutcome;
  }

  const resumeOutcome = await handleResumes(input);
  if (resumeOutcome) {
    return resumeOutcome;
  }

  if (
    input.routingDecision.kind === "ignore" &&
    input.routingDecision.reason === "event_not_configured"
  ) {
    return {
      status: "ignored",
      runMode: input.runMode,
      reason: "event_not_configured",
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
