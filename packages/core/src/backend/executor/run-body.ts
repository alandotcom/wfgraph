/**
 * The pass body of a `run` schedule row: load the Execution and the version it
 * pins, and replay the workflow over the pass's runtime, with the engine's
 * store writing through the pass's watched writes. A run that cannot be loaded
 * answers `unavailable` with the write that ends its row. One body serves
 * every pass of a worker loop, and keeps the versions those passes read.
 */

import { Effect } from "effect";
import { executeWorkflow } from "#src/backend/engine/core";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import { outsideGraphAnnouncement } from "#src/backend/engine/terminal-record";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  noWorkflowEntities,
  type WorkflowEntities,
} from "#src/backend/engine/entities";
import type { PassBody, RunPass } from "#src/backend/executor/pass";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type { RunPassWrites } from "#src/backend/executor/runtime";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import {
  createRunVersionCache,
  loadPersistedRunInput,
  RunInputUnavailable,
} from "#src/backend/services/executions/run-input";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

export function runBody(input: {
  /**
   * Builds the action surface one pass dispatches through. Called once per
   * pass, because the surface keeps the integration credentials it read, and a
   * decrypted secret must not outlive the pass that read it.
   */
  actions: () => WorkflowActions;
  entities?: WorkflowEntities | undefined;
}): PassBody<RunPass, ExecutionRepo | WorkflowRepo> {
  const entities = input.entities ?? noWorkflowEntities;
  const versions = createRunVersionCache();
  return {
    open: (pass) =>
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const { writes } = pass;
        const { executionId } = pass.claimed;
        const loaded = yield* loadPersistedRunInput(executionId, {
          versions,
        }).pipe(
          Effect.catchTag("RunInputUnavailable", (unavailable) =>
            Effect.succeed(unavailable)
          )
        );
        if (loaded instanceof RunInputUnavailable) {
          return {
            kind: "unavailable",
            reason: loaded.reason,
            severity: "info",
            settle: endUnavailableRun(writes, executionId, loaded),
          } as const;
        }
        const store = createDbWorkflowStore({ reads: executions, writes });
        const actions = input.actions();
        return {
          kind: "ready",
          run: (runtime) =>
            executeWorkflow(loaded, runtime, store, actions, entities),
        } as const;
      }),
    fail: (pass, error) =>
      failRun(pass.writes, pass.claimed.executionId, error),
  };
}

/**
 * The write that ends the row of a run that cannot be loaded. A run whose
 * version is missing can never run, so it ends failed. Nothing will run an
 * ended run again, so its schedule row and memo go. A run whose row is gone
 * took its schedule and memo rows with it.
 */
function endUnavailableRun(
  writes: RunPassWrites,
  executionId: string,
  unavailable: RunInputUnavailable
): Effect.Effect<void, DatabaseError | LeaseLost, ExecutionRepo> {
  if (unavailable.reason === "missing_version") {
    return Effect.gen(function* () {
      const end = yield* endingOutsideGraph(
        writes,
        executionId,
        unavailable.message
      );
      if (end !== null) yield* end("failed");
    });
  }
  if (unavailable.reason === "not_in_flight") {
    return writes.dropSchedule();
  }
  return Effect.void;
}

/**
 * The terminal write of a run ended without walking its graph, as the status
 * the caller names, with `error` and the timeline entry that says so. Null
 * when the run's row is gone.
 */
function endingOutsideGraph(
  writes: RunPassWrites,
  executionId: string,
  error: string
) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const run = yield* executions.findSummaryById(executionId);
    if (run === null) return null;
    return (status: "failed" | "canceled" | "exited") =>
      writes.finishRun({
        executionId,
        status,
        error,
        announcement: outsideGraphAnnouncement({
          workflowId: run.workflowId,
          runMode: run.runMode,
          status,
          error,
        }),
      });
  });
}

/**
 * Writes the run's terminal record as failed with `error`. A run holding a
 * Cancel or Exit claim refuses `failed`, so it ends in the status its claim
 * names instead, carrying the same error.
 */
function failRun(writes: RunPassWrites, executionId: string, error: string) {
  return Effect.gen(function* () {
    const end = yield* endingOutsideGraph(writes, executionId, error);
    if (end === null) return;
    const written = yield* end("failed");
    const claim = written?.claim;
    if (
      written === null ||
      written.didWrite ||
      claim === null ||
      claim === undefined ||
      !IN_FLIGHT_EXECUTION_STATUSES.some((status) => status === written.status)
    ) {
      return;
    }
    yield* end(claim.kind === "cancel" ? "canceled" : "exited");
  });
}
