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
  dryRun: boolean;
  eventType?: string;
  correlationKey?: string;
  routingDecision: TriggerRoutingDecision;
  waitStates: TriggerWaitState[];
  enableResumes: boolean;
  startExecution: () => Promise<{
    executionId: string;
    runId?: string;
    dryRun: boolean;
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

function toCancellationSummary(
  waitStates: TriggerWaitState[]
): CancellationSummary {
  return {
    cancelledExecutions: new Set(waitStates.map((state) => state.executionId))
      .size,
    cancelledWaits: waitStates.length,
  };
}

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
      reason: "no_waiting_runs",
    };
  }

  if (input.routingDecision.kind === "stop") {
    if (input.dryRun) {
      return {
        status: "cancelled",
        dryRun: true,
        simulated: true,
        ...toCancellationSummary(input.waitStates),
      };
    }

    return {
      status: "cancelled",
      dryRun: false,
      ...(await input.cancelWaitStates(input.eventType)),
    };
  }

  const cancellationSummary = input.dryRun
    ? {
        ...toCancellationSummary(input.waitStates),
        simulated: true,
      }
    : await input.cancelWaitStates(input.eventType);

  const execution = await input.startExecution();
  return {
    status: "running",
    executionId: execution.executionId,
    runId: execution.runId,
    dryRun: execution.dryRun,
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

  if (input.dryRun) {
    const resumableCount = countResumableWaitStates(
      input.waitStates,
      input.eventType
    );
    if (resumableCount > 0) {
      return {
        status: "resumed",
        resumedCount: resumableCount,
        dryRun: true,
        simulated: true,
      };
    }
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
      reason: "event_not_configured",
    };
  }

  const execution = await input.startExecution();
  return {
    status: "running",
    executionId: execution.executionId,
    runId: execution.runId,
    dryRun: execution.dryRun,
  };
}
