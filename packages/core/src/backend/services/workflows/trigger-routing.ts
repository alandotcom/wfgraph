import type { ResolvedTriggerRouting } from "@rova/shared/workflow/routing-policy";
import { cancelInFlightRuns } from "#src/backend/lib/workflow-cancellation";
import {
  listWorkflowInFlightExecutionsByCorrelation,
  listWorkflowWaitingStatesByCorrelation,
} from "#src/backend/lib/workflow-wait-state";
import {
  orchestrateTriggerExecution,
  type TriggerOrchestratorResult,
  type TriggerWaitState,
} from "./trigger-orchestrator";

type TriggerRoutingLogger = {
  error: (message: string, properties?: Record<string, unknown>) => void;
  info: (message: string, properties?: Record<string, unknown>) => void;
};

/**
 * The assembly every entrypoint shares between resolving a routing and
 * acting on it: fetch the correlation key's candidates (waiting states for
 * resume matching, in-flight executions for cancel/replace), wire the
 * cancellation closure with its reason, and orchestrate. Entrypoints supply
 * only what genuinely differs: how a run starts, whether resumes are
 * enabled, and the noun naming them in cancel reasons.
 */
export async function orchestrateRoutedTrigger(input: {
  workflowId: string;
  runMode: "live" | "test";
  routing: ResolvedTriggerRouting;
  /** Names the entrypoint in cancel reasons, e.g. "webhook event". */
  sourceNoun: string;
  enableResumes: boolean;
  logger: TriggerRoutingLogger;
  startExecution: () => Promise<{
    executionId: string;
    runId?: string;
    runMode: "live" | "test";
  }>;
  resumeWaitStates: (
    eventType: string,
    waitStates: TriggerWaitState[]
  ) => Promise<number>;
}): Promise<TriggerOrchestratorResult> {
  const { routing } = input;
  const { correlationKey } = routing;

  const [waitStates, inFlightExecutions] =
    correlationKey === undefined
      ? [[], []]
      : await Promise.all([
          listWorkflowWaitingStatesByCorrelation({
            workflowId: input.workflowId,
            correlationKey,
            runMode: input.runMode,
          }),
          listWorkflowInFlightExecutionsByCorrelation({
            workflowId: input.workflowId,
            correlationKey,
            runMode: input.runMode,
          }),
        ]);
  const inFlightExecutionIds = inFlightExecutions.map(
    (execution) => execution.id
  );

  return await orchestrateTriggerExecution({
    runMode: input.runMode,
    routing,
    inFlightExecutionIds,
    waitStates,
    enableResumes: input.enableResumes,
    startExecution: input.startExecution,
    cancelInFlightRuns: async (eventType) =>
      await cancelInFlightRuns({
        workflowId: input.workflowId,
        executionIds: inFlightExecutionIds,
        waitStates,
        eventType,
        reason:
          routing.action === "replace"
            ? `Replaced by ${input.sourceNoun} ${eventType}`
            : `Cancelled by ${input.sourceNoun} ${eventType}`,
        logger: input.logger,
      }),
    resumeWaitStates: input.resumeWaitStates,
  });
}
