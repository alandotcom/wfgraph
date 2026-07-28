import { Effect } from "effect";
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

type StartedRun = {
  executionId: string;
  runId?: string;
  runMode: "live" | "test";
};

/**
 * Waking the waits an event matches, when the entrypoint can do that at all.
 *
 * Answers how many woke; a zero means nothing matched, which the orchestrator
 * treats as "no resume happened" rather than as a failure.
 */
export type ResumeWaitStates<E, R> = (
  eventType: string,
  waitStates: TriggerWaitState[]
) => Effect.Effect<number, E, R>;

/**
 * The things acting on a routing needs done, each as an Effect the entrypoint
 * supplies.
 *
 * Generic over their failures and their services rather than naming either: the
 * manual, webhook, and event paths start a run differently and reach different
 * repositories, and nothing in the ordering below depends on which. Keeping them
 * open is what lets this file hold the policy and nothing else.
 *
 * `resumeWaitStates` is optional because supporting resumes is the same thing as
 * being able to perform one. A manual run has no delivering event to wake a wait
 * with, so it supplies no callback, and the return type says so.
 */
type TriggerOrchestratorInput<E, R> = {
  runMode: "live" | "test";
  routing: ResolvedTriggerRouting;
  /** Every in-flight execution for the correlation key. */
  inFlightExecutionIds: string[];
  /** Wait states for the waiting subset of those executions. */
  waitStates: TriggerWaitState[];
  startExecution: () => Effect.Effect<StartedRun, E, R>;
  cancelInFlightRuns: (
    eventType?: string
  ) => Effect.Effect<CancellationSummary, E, R>;
  resumeWaitStates?: ResumeWaitStates<E, R>;
};

export type TriggerOrchestratorResult =
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionIgnoredResponse
  | WorkflowExecutionResumedResponse;

/**
 * What is left when no resume callback was supplied: a caller that cannot
 * resume never has to handle a resumed answer, and gets a compile error rather
 * than a dead branch if it tries.
 */
export type TriggerOrchestratorResultWithoutResume = Exclude<
  TriggerOrchestratorResult,
  WorkflowExecutionResumedResponse
>;

const handleCancelOrReplace = <E, R>(
  input: TriggerOrchestratorInput<E, R>
): Effect.Effect<
  | WorkflowExecutionCancelledResponse
  | WorkflowExecutionRunningResponse
  | WorkflowExecutionIgnoredResponse
  | undefined,
  E,
  R
> =>
  Effect.gen(function* () {
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
        } as const;
      }
      // replace with nothing running → fall through to start a new execution
      return undefined;
    }

    if (routing.action === "cancel") {
      return {
        status: "cancelled",
        runMode: input.runMode,
        ...(yield* input.cancelInFlightRuns(routing.eventType)),
      } as const;
    }

    const cancellationSummary = yield* input.cancelInFlightRuns(
      routing.eventType
    );
    const execution = yield* input.startExecution();
    return {
      status: "running",
      executionId: execution.executionId,
      runId: execution.runId,
      runMode: execution.runMode,
      ...cancellationSummary,
    } as const;
  });

const handleResumes = <E, R>(
  input: TriggerOrchestratorInput<E, R>
): Effect.Effect<WorkflowExecutionResumedResponse | undefined, E, R> =>
  Effect.gen(function* () {
    const { resumeWaitStates } = input;
    if (!resumeWaitStates) {
      return undefined;
    }

    const { eventType, correlationKey } = input.routing;
    if (!(eventType && correlationKey) || input.waitStates.length === 0) {
      return undefined;
    }

    // Which waits an event wakes is resume matching's own knowledge; a zero
    // return means nothing matched and costs nothing, so there is no
    // pre-count here to drift from the real predicate.
    const resumedCount = yield* resumeWaitStates(eventType, input.waitStates);
    if (resumedCount > 0) {
      return {
        status: "resumed",
        resumedCount,
        runMode: input.runMode,
      } as const;
    }

    return undefined;
  });

/**
 * Acts on a resolved routing action. Ordering carries two deliberate rules:
 * the policy wins over waits (a cancel/replace kills waiting runs before
 * resume matching ever sees the event), and a resume wins over start (an
 * Event Type mapped to Start that a waiting run is listening for wakes that
 * run instead of starting a new one, since the waiting run consumes the event).
 * An ignored event still reaches resume matching, which is the sanctioned
 * way to express "this event only wakes waits".
 *
 * The two signatures differ only in the answer: supply `resumeWaitStates` and
 * "resumed" joins the outcomes, leave it out and it cannot occur.
 */
export function orchestrateTriggerExecution<E, R>(
  input: TriggerOrchestratorInput<E, R> & {
    resumeWaitStates: ResumeWaitStates<E, R>;
  }
): Effect.Effect<TriggerOrchestratorResult, E, R>;
export function orchestrateTriggerExecution<E, R>(
  input: TriggerOrchestratorInput<E, R> & { resumeWaitStates?: undefined }
): Effect.Effect<TriggerOrchestratorResultWithoutResume, E, R>;
export function orchestrateTriggerExecution<E, R>(
  input: TriggerOrchestratorInput<E, R>
): Effect.Effect<TriggerOrchestratorResult, E, R> {
  return Effect.gen(function* () {
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
      } as const;
    }

    const cancelOrReplaceOutcome = yield* handleCancelOrReplace(input);
    if (cancelOrReplaceOutcome) {
      return cancelOrReplaceOutcome;
    }

    const resumeOutcome = yield* handleResumes(input);
    if (resumeOutcome) {
      return resumeOutcome;
    }

    if (routing.action === "ignore") {
      return {
        status: "ignored",
        runMode: input.runMode,
        reason: routing.ignoreReason,
      } as const;
    }

    const execution = yield* input.startExecution();
    return {
      status: "running",
      executionId: execution.executionId,
      runId: execution.runId,
      runMode: execution.runMode,
    } as const;
  });
}
