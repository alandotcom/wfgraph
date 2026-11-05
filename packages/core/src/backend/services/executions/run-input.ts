/**
 * The engine input for one run of a persisted Execution, read from the
 * execution row, its workflow, and the Workflow Version the row pins at the
 * moment of the read. Both executors load it at the start of every pass, so a
 * body always walks the version a Migration last pinned. A run that cannot be
 * loaded answers `RunInputUnavailable`, which no retry can mend.
 */

import { Effect, Schema } from "effect";
import type { WorkflowExecutionInput } from "#src/backend/engine/core";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { ExecutionSummary } from "#src/backend/services/executions/repo/contracts";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

/**
 * Why a run could not be loaded: the execution row is gone, it is no longer in
 * flight, or the version it pins is missing or belongs to another workflow.
 */
export class RunInputUnavailable extends Schema.TaggedError<
  RunInputUnavailable,
  { readonly brand: unique symbol }
>()("RunInputUnavailable", {
  reason: Schema.Literals([
    "missing_execution",
    "not_in_flight",
    "missing_version",
  ]),
  message: Schema.String,
}) {}

function isInFlightStatus(status: ExecutionSummary["status"]): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((inFlight) => inFlight === status);
}

export function loadPersistedRunInput(
  executionId: string
): Effect.Effect<
  WorkflowExecutionInput,
  RunInputUnavailable | DatabaseError,
  ExecutionRepo | WorkflowRepo
> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const workflows = yield* WorkflowRepo;
    const execution = yield* executions.findSummaryById(executionId);
    if (!execution) {
      return yield* new RunInputUnavailable({
        reason: "missing_execution",
        message: "The requested workflow execution does not exist",
      });
    }
    if (!isInFlightStatus(execution.status)) {
      return yield* new RunInputUnavailable({
        reason: "not_in_flight",
        message: "The requested workflow execution is no longer in flight",
      });
    }

    const [workflow, version] = yield* Effect.all([
      workflows.findById(execution.workflowId),
      workflows.findVersionById(execution.workflowVersionId),
    ]);
    if (!workflow || !version || version.workflowId !== execution.workflowId) {
      return yield* new RunInputUnavailable({
        reason: "missing_version",
        message: "The requested workflow version does not exist",
      });
    }

    return {
      graph: version.graph,
      workflowVersionId: version.id,
      catalogFingerprint: version.catalogFingerprint,
      startPayload: execution.input ?? {},
      requestPayload: execution.input ?? {},
      startEventName: execution.startEventName ?? undefined,
      executionId: execution.id,
      workflowId: execution.workflowId,
      workflowName: workflow.name,
      entityType: execution.entityType ?? undefined,
      entityId: execution.entityId ?? undefined,
      runMode: execution.runMode,
    };
  });
}
