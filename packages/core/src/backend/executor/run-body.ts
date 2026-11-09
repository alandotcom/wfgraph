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
 * version is missing can never run, so it ends outside its graph. Nothing will
 * run an ended run again, so its schedule row and memo go. A run
 * whose row is gone took its schedule and memo rows with it.
 */
function endUnavailableRun(
  writes: RunPassWrites,
  executionId: string,
  unavailable: RunInputUnavailable
): Effect.Effect<void, DatabaseError | LeaseLost> {
  if (unavailable.reason === "missing_version") {
    return failRun(writes, executionId, unavailable.message);
  }
  if (unavailable.reason === "not_in_flight") {
    return writes.dropSchedule();
  }
  return Effect.void;
}

/** Ends the run outside its graph, which is canceled or exited when it holds a claim. */
function failRun(writes: RunPassWrites, executionId: string, error: string) {
  return writes
    .endRun({ executionId, ending: { kind: "outsideGraph", error } })
    .pipe(Effect.asVoid);
}
