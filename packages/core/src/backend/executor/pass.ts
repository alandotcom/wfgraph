/**
 * One pass of the database executor over one claimed schedule row: load the
 * run and its memo, replay the body with every store write fenced on the
 * claim's owner token, and release the row by how the body ended. The caller
 * claims the row first (`ExecutionRepo.claimDue`). A pass that loses its lease
 * writes nothing after the write that found it out, its release included.
 */

import { Cause, Effect, Exit } from "effect";
import { executeWorkflow } from "#src/backend/engine/core";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  noWorkflowEntities,
  type WorkflowEntities,
} from "#src/backend/engine/entities";
import { failureFromUnknown } from "#src/backend/engine/engine-failure";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import {
  createExecutorRuntime,
  createPassState,
  stepFailureMemo,
  watchPassWrites,
} from "#src/backend/executor/runtime";
import {
  type ClaimedExecution,
  ExecutionRepo,
  type PassOutcome,
  type ReleasedSchedule,
} from "#src/backend/services/executions/repo";
import {
  loadPersistedRunInput,
  RunInputUnavailable,
} from "#src/backend/services/executions/run-input";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";

/**
 * How many times a failing step is retried before it fails its node, the
 * count the Inngest path gives the same step.
 */
export const STEP_RETRY_LIMIT = 4;

/** The default wait before a retry: one second, doubling, at most a minute. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 60_000);
}

/**
 * What one pass did with its run.
 *
 * - `ended`: the body wrote the run's terminal record, which deleted the
 *   schedule row and the memo.
 * - `parked`: the body ended with Waits parked. The release re-queued the run
 *   when a park holds a wake the pass did not read, and otherwise put it to
 *   sleep until its earliest park deadline.
 * - `retry`: a step threw, or the body failed outside any step. The release
 *   counted an attempt and re-queued the run after a backoff.
 * - `retries_spent`: a step threw on its last retry. The release recorded the
 *   failure as that step's value, so the next pass fails the step's node and
 *   the rest of the run goes on.
 * - `fence_refused` on `version`: a Migration moved the run off the version
 *   this pass loaded. The release re-queued it with the attempt unchanged.
 * - `fence_refused` on `owner`: a fenced write found the schedule row no
 *   longer names this pass. Nothing else was written, the release included.
 * - `unavailable`: the run could not be loaded. The pass wrote the terminal
 *   record when the version is missing, and nothing for a run that is gone or
 *   already ended.
 */
export type PassResult =
  | { kind: "ended" }
  | { kind: "parked"; schedule: ReleasedSchedule }
  | { kind: "retry"; error: string; schedule: ReleasedSchedule }
  | { kind: "retries_spent"; stepId: string; schedule: ReleasedSchedule }
  | { kind: "fence_refused"; fence: "version"; schedule: ReleasedSchedule }
  | { kind: "fence_refused"; fence: "owner" }
  | { kind: "unavailable"; reason: RunInputUnavailable["reason"] };

export type PassOptions = {
  /** The clock every lease, memo and release write is stamped with. */
  now: () => Date;
  /** How long a memo write renews the lease for. */
  leaseMs: number;
  actions: WorkflowActions;
  entities?: WorkflowEntities | undefined;
  /** Defaults to `STEP_RETRY_LIMIT`. */
  retryLimit?: number | undefined;
  /** Defaults to `retryBackoffMs`. */
  backoffMs?: ((attempt: number) => number) | undefined;
};

/** Why a body that did not end on its own stopped, as the release reads it. */
type Failure = { stepId: string | undefined; message: string };

export function runPass(
  claimed: ClaimedExecution,
  options: PassOptions
): Effect.Effect<PassResult, DatabaseError, ExecutionRepo | WorkflowRepo> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const { executionId } = claimed;
    const fence = { executionId, ownerToken: claimed.ownerToken };
    const state = createPassState();
    const writes = watchPassWrites({
      fenced: executions.fenced(fence),
      unfenced: executions,
      state,
    });

    const release = (outcome: PassOutcome) =>
      writes.releasePass({ outcome, now: options.now() }).pipe(
        Effect.map((schedule) => ({ owned: true as const, schedule })),
        Effect.catchTag("Conflict", () =>
          Effect.succeed({ owned: false as const })
        )
      );

    const loaded = yield* loadPersistedRunInput(executionId).pipe(
      Effect.catchTag("RunInputUnavailable", (unavailable) =>
        Effect.succeed(unavailable)
      )
    );
    if (loaded instanceof RunInputUnavailable) {
      if (loaded.reason === "missing_version") {
        yield* Effect.ignore(
          writes.finishRun({
            executionId,
            status: "failed",
            error: loaded.message,
          })
        );
      }
      return { kind: "unavailable", reason: loaded.reason } as const;
    }

    const memo = yield* executions.listStepMemo(executionId);
    const context = yield* Effect.context();
    const runEffect = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
      const exit = await Effect.runPromiseExitWith(context)(effect);
      if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
      }
      return exit.value;
    };

    const runtime = createExecutorRuntime({
      executionId,
      attempt: claimed.attempt,
      memo: new Map(memo.map((entry) => [entry.stepId, entry.value])),
      writes,
      findPark: executions.findPark,
      state,
      leaseExpiresAt: () => new Date(options.now().getTime() + options.leaseMs),
      runEffect,
    });
    const store = createDbWorkflowStore({ reads: executions, writes });

    const body = yield* Effect.exit(
      executeWorkflow(
        loaded,
        runtime,
        store,
        options.actions,
        options.entities ?? noWorkflowEntities
      )
    );

    const phase = state.phase();
    const stop = phase.kind === "stopped" ? phase.stop : undefined;
    if (stop?.kind === "lease_lost") {
      return { kind: "fence_refused", fence: "owner" } as const;
    }

    const failure: Failure | undefined =
      stop?.kind === "step_threw"
        ? {
            stepId: stop.stepId,
            message: failureFromUnknown(stop.error).message,
          }
        : Exit.isFailure(body)
          ? {
              stepId: undefined,
              message: failureFromUnknown(Cause.squash(body.cause)).message,
            }
          : undefined;

    if (failure === undefined) {
      if (phase.kind === "ended") {
        return { kind: "ended" } as const;
      }
      const released = yield* release({ kind: "parked" });
      return released.owned
        ? ({ kind: "parked", schedule: released.schedule } as const)
        : ({ kind: "fence_refused", fence: "owner" } as const);
    }

    // A version fence refuses a write with a step failure, so a failure is
    // read as the run having moved whenever the version it pins is no longer
    // the one this pass loaded.
    const pinned = yield* executions.findSummaryById(executionId);
    const outcome = decideFailedPass({
      failure,
      migrated: pinned?.workflowVersionId !== loaded.workflowVersionId,
      attempt: claimed.attempt,
      retryLimit: options.retryLimit ?? STEP_RETRY_LIMIT,
      backoffMs: options.backoffMs ?? retryBackoffMs,
    });
    const released = yield* release(outcome);
    if (!released.owned) {
      return { kind: "fence_refused", fence: "owner" } as const;
    }
    return passResultOf(outcome, released.schedule);
  });
}

/** What a failed pass answers for the release it wrote. */
function passResultOf(
  outcome: PassOutcome,
  schedule: ReleasedSchedule
): PassResult {
  if (outcome.kind === "fence_refused") {
    return { kind: "fence_refused", fence: "version", schedule };
  }
  if (outcome.kind === "retries_spent") {
    return { kind: "retries_spent", stepId: outcome.stepId, schedule };
  }
  if (outcome.kind === "retry") {
    return { kind: "retry", error: outcome.error, schedule };
  }
  return { kind: "parked", schedule };
}

/**
 * The release a failed pass writes. A step's retries are spent once the
 * attempt after this one would pass `retryLimit`; a failure no step owns is
 * retried without that limit, since there is no step to fail in its place.
 */
function decideFailedPass(input: {
  failure: Failure;
  migrated: boolean;
  attempt: number;
  retryLimit: number;
  backoffMs: (attempt: number) => number;
}): PassOutcome {
  const { failure } = input;
  if (input.migrated) {
    return { kind: "fence_refused" };
  }
  if (failure.stepId !== undefined && input.attempt + 1 > input.retryLimit) {
    return {
      kind: "retries_spent",
      stepId: failure.stepId,
      failure: stepFailureMemo(failure.message),
    };
  }
  return {
    kind: "retry",
    error: failure.message,
    backoffMs: input.backoffMs(input.attempt),
  };
}
