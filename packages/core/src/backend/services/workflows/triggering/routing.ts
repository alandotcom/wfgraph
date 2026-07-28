import { Effect } from "effect";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import {
  callDbModule,
  type DatabaseError,
} from "#src/backend/lib/effect/database";
import {
  callInngestModule,
  type InngestError,
} from "#src/backend/lib/effect/inngest-client";
import { cancelInFlightRuns } from "#src/backend/lib/workflow-cancellation";
import {
  listWorkflowInFlightExecutionsByCorrelation,
  listWorkflowWaitingStatesByCorrelation,
} from "#src/backend/lib/workflow-wait-state";
import type { ResolvedTriggerRouting } from "@rova/shared/workflow/routing-policy";
import {
  orchestrateTriggerExecution,
  type ResumeWaitStates,
  type TriggerOrchestratorResult,
  type TriggerOrchestratorResultWithoutResume,
} from "#src/backend/services/workflows/triggering/orchestrator";

/**
 * The logger `cancelInFlightRuns` takes: plain calls, because that module still
 * speaks Promises and writes its operator lines as it goes.
 *
 * Running a log Effect here is safe and stays so only while these lines are
 * `Effect.sync` over logtape, which is the whole of what `AppLogger` builds.
 * Stage 7 brings cancellation itself onto Effect and this bridge goes with it.
 */
function toPlainLogger(logger: EffectLogger) {
  return {
    error: (message: string, properties?: Record<string, unknown>) =>
      Effect.runSync(logger.error(message, properties)),
    info: (message: string, properties?: Record<string, unknown>) =>
      Effect.runSync(logger.info(message, properties)),
  };
}

type RoutedTriggerInput<E, R> = {
  workflowId: string;
  runMode: "live" | "test";
  routing: ResolvedTriggerRouting;
  /** Names the entrypoint in cancel reasons, e.g. "webhook event". */
  sourceNoun: string;
  logger: EffectLogger;
  startExecution: () => Effect.Effect<
    { executionId: string; runId?: string; runMode: "live" | "test" },
    E,
    R
  >;
  /** Absent for an entrypoint that has no delivering event to wake a wait with. */
  resumeWaitStates?: ResumeWaitStates<E, R>;
};

/**
 * The assembly every entrypoint shares between resolving a routing and
 * acting on it: fetch the correlation key's candidates (waiting states for
 * resume matching, in-flight executions for cancel/replace), wire the
 * cancellation closure with its reason, and orchestrate. Entrypoints supply
 * only what genuinely differs: how a run starts, whether they can resume a
 * wait at all, and the noun naming them in cancel reasons.
 *
 * The two signatures carry the orchestrator's own distinction through: an
 * entrypoint that supplies no resume callback is answered a result that has no
 * "resumed" case in it.
 */
export function orchestrateRoutedTrigger<E, R>(
  input: RoutedTriggerInput<E, R> & { resumeWaitStates: ResumeWaitStates<E, R> }
): Effect.Effect<
  TriggerOrchestratorResult,
  E | DatabaseError | InngestError,
  R
>;
export function orchestrateRoutedTrigger<E, R>(
  input: RoutedTriggerInput<E, R> & { resumeWaitStates?: undefined }
): Effect.Effect<
  TriggerOrchestratorResultWithoutResume,
  E | DatabaseError | InngestError,
  R
>;
export function orchestrateRoutedTrigger<E, R>(
  input: RoutedTriggerInput<E, R>
): Effect.Effect<
  TriggerOrchestratorResult,
  E | DatabaseError | InngestError,
  R
> {
  return Effect.gen(function* () {
    const { routing } = input;
    const { correlationKey } = routing;

    const [waitStates, inFlightExecutions] =
      correlationKey === undefined
        ? [[], []]
        : yield* Effect.all(
            [
              callDbModule(() =>
                listWorkflowWaitingStatesByCorrelation({
                  workflowId: input.workflowId,
                  correlationKey,
                  runMode: input.runMode,
                })
              ),
              callDbModule(() =>
                listWorkflowInFlightExecutionsByCorrelation({
                  workflowId: input.workflowId,
                  correlationKey,
                  runMode: input.runMode,
                })
              ),
            ],
            { concurrency: "unbounded" }
          );

    const inFlightExecutionIds = inFlightExecutions.map(
      (execution) => execution.id
    );

    const shared = {
      runMode: input.runMode,
      routing,
      inFlightExecutionIds,
      waitStates,
      startExecution: input.startExecution,
      cancelInFlightRuns: (eventType?: string) =>
        callInngestModule(() =>
          cancelInFlightRuns({
            workflowId: input.workflowId,
            executionIds: inFlightExecutionIds,
            waitStates,
            eventType,
            reason:
              routing.action === "replace"
                ? `Replaced by ${input.sourceNoun} ${eventType}`
                : `Cancelled by ${input.sourceNoun} ${eventType}`,
            logger: toPlainLogger(input.logger),
          })
        ),
    };

    // The branch is what picks the orchestrator's signature: passing an
    // optional callback through would match neither, since "supplied" and
    // "absent" are what the two overloads are distinguishing.
    const resumeWaitStates = input.resumeWaitStates;
    return yield* resumeWaitStates
      ? orchestrateTriggerExecution<E | DatabaseError | InngestError, R>({
          ...shared,
          resumeWaitStates,
        })
      : orchestrateTriggerExecution<E | DatabaseError | InngestError, R>(
          shared
        );
  });
}
