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
import {
  DatabaseError,
  type LeaseLost,
} from "#src/backend/lib/effect/database";
import type { RunPassWrites } from "#src/backend/executor/runtime";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import {
  createRunVersionCache,
  loadPersistedRunInput,
  RunInputUnavailable,
} from "#src/backend/services/executions/run-input";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { catchUpParkedWait } from "#src/backend/services/workflows/lifecycle/resume-waits";

/**
 * Every service a run's pass reads: the run's repositories, and what an
 * event-mode Wait's first park reads to catch up on an arrival it missed.
 */
export type RunServices =
  | ExecutionRepo
  | WorkflowRepo
  | Effect.Services<ReturnType<typeof catchUpParkedWait>>;

export function runBody(input: {
  /**
   * Builds the action surface one pass dispatches through. Called once per
   * pass, because the surface keeps the integration credentials it read, and a
   * decrypted secret must not outlive the pass that read it.
   */
  actions: () => WorkflowActions;
  entities?: WorkflowEntities | undefined;
}): PassBody<RunPass, RunServices> {
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
        // Read here, before any step runs, so a failed read is the pass's
        // own failure and no step is charged with it.
        const logRows = yield* executions.listNodeLogStates(executionId);
        const services = yield* Effect.context<RunServices>();
        const store = createDbWorkflowStore({
          executionId,
          reads: executions,
          writes,
          logRows,
          // A producer's refused write is the store's database failure here,
          // which the pass answers as it answers any other.
          catchUpWait: (waitStateId) =>
            catchUpParkedWait(waitStateId).pipe(
              Effect.catchTag("DriverError", (error) =>
                Effect.fail(new DatabaseError({ cause: error.cause }))
              ),
              Effect.provide(services)
            ),
        });
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

/**
 * Ends the run outside its graph, which is canceled or exited when it holds a
 * claim. An outside-graph ending leaves only a run that already ended or is
 * gone, and nothing will run either again, so the pass then deletes the
 * schedule row it holds.
 */
function failRun(
  writes: RunPassWrites,
  executionId: string,
  error: string
): Effect.Effect<void, DatabaseError | LeaseLost> {
  return writes
    .endRun({ executionId, ending: { kind: "outsideGraph", error } })
    .pipe(
      Effect.flatMap((answer) =>
        answer.kind === "ended" ? Effect.void : writes.dropSchedule()
      )
    );
}
