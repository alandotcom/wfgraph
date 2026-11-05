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
import {
  type EngineFailure,
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import {
  createExecutorRuntime,
  createPassState,
  type PassState,
  stepFailureMemo,
  watchPassWrites,
} from "#src/backend/executor/runtime";
import {
  type ClaimedExecution,
  ExecutionRepo,
  type FencedExecutionWrites,
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
 * - `fence_refused` on `version`: the engine reported a version fence refused
 *   a write, because a Migration moved the run off the version this pass
 *   loaded. The release re-queued it with the attempt unchanged.
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
  /** How long a memo write or a heartbeat renews the lease for. */
  leaseMs: number;
  /**
   * How often the lease is renewed while the body runs. Omitted, only a memo
   * write renews it, so a step body that outlasts `leaseMs` loses the lease.
   */
  heartbeatMs?: number | undefined;
  actions: WorkflowActions;
  entities?: WorkflowEntities | undefined;
  /** Defaults to `STEP_RETRY_LIMIT`. */
  retryLimit?: number | undefined;
  /** Defaults to `retryBackoffMs`. */
  backoffMs?: ((attempt: number) => number) | undefined;
};

/**
 * Why a body that did not end on its own stopped, as the release reads it: the
 * step that threw, if a step did, and the engine's failure.
 */
type Failure = { stepId: string | undefined; failure: EngineFailure };

export function runPass(
  claimed: ClaimedExecution,
  options: PassOptions
): Effect.Effect<PassResult, DatabaseError, ExecutionRepo | WorkflowRepo> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const { executionId } = claimed;
    const fence = { executionId, ownerToken: claimed.ownerToken };
    const state = createPassState();
    const fenced = executions.fenced(fence);
    const writes = watchPassWrites({
      fenced,
      unfenced: executions,
      state,
    });
    const leaseExpiresAt = () =>
      new Date(options.now().getTime() + options.leaseMs);

    const release = (outcome: PassOutcome) =>
      writes.releasePass({ outcome, now: options.now() }).pipe(
        Effect.map((schedule) => ({ owned: true as const, schedule })),
        Effect.catchTag("LeaseLost", () =>
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
      leaseExpiresAt,
      runEffect,
    });
    const store = createDbWorkflowStore({ reads: executions, writes });

    const runBody = Effect.exit(
      executeWorkflow(
        loaded,
        runtime,
        store,
        options.actions,
        options.entities ?? noWorkflowEntities
      )
    );
    const { heartbeatMs } = options;
    // The heartbeat is a fiber scoped to the body: it starts with the body and
    // is interrupted once the body has ended, before the release is written.
    const body =
      heartbeatMs === undefined
        ? yield* runBody
        : yield* Effect.scoped(
            Effect.forkScoped(
              renewLeaseWhileRunning({
                fenced,
                findSchedule: executions.findSchedule,
                executionId,
                state,
                everyMs: heartbeatMs,
                leaseExpiresAt,
              })
            ).pipe(Effect.andThen(runBody))
          );

    const phase = state.phase();
    const stop = phase.kind === "stopped" ? phase.stop : undefined;
    if (stop?.kind === "lease_lost") {
      return { kind: "fence_refused", fence: "owner" } as const;
    }

    const failure: Failure | undefined =
      stop?.kind === "step_threw"
        ? { stepId: stop.stepId, failure: failureFromUnknown(stop.error) }
        : Exit.isFailure(body)
          ? { stepId: undefined, failure: failureFromCause(body.cause) }
          : undefined;

    if (failure === undefined) {
      // No step threw and the body raised nothing, so the body's own answer
      // says whether this pass ended the run or parked it.
      if (Exit.isSuccess(body) && body.value.kind === "ended") {
        return { kind: "ended" } as const;
      }
      const released = yield* release({ kind: "parked" });
      return released.owned
        ? ({ kind: "parked", schedule: released.schedule } as const)
        : ({ kind: "fence_refused", fence: "owner" } as const);
    }

    const outcome = decideFailedPass({
      failure,
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

/**
 * Whether the pass still owes its run a release, and so still needs its
 * lease: it is running, or a step threw and the body is winding down.
 */
function needsLease(state: PassState): boolean {
  const phase = state.phase();
  return (
    phase.kind === "running" ||
    (phase.kind === "stopped" && phase.stop.kind === "step_threw")
  );
}

/**
 * How one heartbeat ended: the lease moved, the database failed the write,
 * the fence refused it with the run still scheduled, or the fence refused it
 * because the run's schedule row is gone.
 */
type Beat = "renewed" | "failed" | "refused" | "run_ended";

/**
 * The pass's heartbeat: every `everyMs` while the pass needs its lease, move
 * the lease to end `leaseMs` from now through the fenced `renewLease`.
 *
 * A refused renewal stops the pass as a lost lease, so the body starts no
 * further step and writes nothing more. The one exception is a refusal that
 * finds the schedule row gone: the run has ended, and when it was this pass's
 * own terminal write the pass must keep the `ended` phase that write set, so
 * the heartbeat stops and leaves it alone. A renewal the database fails is
 * logged and tried again on the next beat. Each renewal is uninterruptible, so
 * the interrupt at the end of the body waits for one already sent.
 */
function renewLeaseWhileRunning(input: {
  fenced: FencedExecutionWrites;
  findSchedule: ExecutionRepo["Service"]["findSchedule"];
  executionId: string;
  state: PassState;
  everyMs: number;
  leaseExpiresAt: () => Date;
}): Effect.Effect<void> {
  const { state, executionId } = input;
  const beat: Effect.Effect<Beat> = Effect.gen(function* () {
    const renewal = yield* input.fenced
      .renewLease({ leaseExpiresAt: input.leaseExpiresAt() })
      .pipe(
        Effect.as("renewed" as const),
        Effect.catchTag("LeaseLost", () => Effect.succeed("refused" as const))
      );
    if (renewal === "renewed") return renewal;
    if ((yield* input.findSchedule(executionId)) === null) {
      return "run_ended" as const;
    }
    state.leaseLost();
    return renewal;
  }).pipe(
    Effect.catchTag("DatabaseError", (error) =>
      Effect.logWarning("Could not renew a pass's lease").pipe(
        Effect.annotateLogs({ pass: { execution: executionId }, error }),
        Effect.as("failed" as const)
      )
    ),
    Effect.uninterruptible
  );

  return Effect.gen(function* () {
    while (needsLease(state)) {
      yield* Effect.sleep(input.everyMs);
      if (!needsLease(state)) return;
      const renewal = yield* beat;
      if (renewal === "refused" || renewal === "run_ended") return;
    }
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
 * The release a failed pass writes. A version fence the engine reports refused
 * is the run having moved, so nothing failed and no attempt is counted. A
 * step's retries are spent once the attempt after this one would pass
 * `retryLimit`; a failure no step owns is retried without that limit, since
 * there is no step to fail in its place.
 */
function decideFailedPass(input: {
  failure: Failure;
  attempt: number;
  retryLimit: number;
  backoffMs: (attempt: number) => number;
}): PassOutcome {
  const { stepId, failure } = input.failure;
  if (failure.kind === "version_refused") {
    return { kind: "fence_refused" };
  }
  if (stepId !== undefined && input.attempt + 1 > input.retryLimit) {
    return {
      kind: "retries_spent",
      stepId,
      failure: stepFailureMemo(failure.message),
    };
  }
  return {
    kind: "retry",
    error: failure.message,
    backoffMs: input.backoffMs(input.attempt),
  };
}
