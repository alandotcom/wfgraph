/**
 * One pass of the database executor over one claimed schedule row: load the
 * run and its memo, replay the body with every store write fenced on the
 * claim's owner token, and release the row by how the body ended. The caller
 * claims the row first (`ExecutionRepo.claimDue`). A pass that loses its lease
 * writes nothing after the write that found it out, its release included.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { executeWorkflow } from "#src/backend/engine/core";
import { createDbWorkflowStore } from "#src/backend/engine/db-store";
import type { WorkflowActions } from "#src/backend/engine/actions";
import {
  noWorkflowEntities,
  type WorkflowEntities,
} from "#src/backend/engine/entities";
import {
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import {
  createExecutorRuntime,
  createPassState,
  type PassState,
  watchPassWrites,
} from "#src/backend/executor/runtime";
import {
  type ClaimedExecution,
  ExecutionRepo,
  type FencedExecutionWrites,
  type PassOutcome,
  type ReleasedPass,
  type ReleasedSchedule,
  type StepMemo,
} from "#src/backend/services/executions/repo";
import {
  retryBackoffMs,
  runRetriesSpent,
} from "#src/backend/services/executions/repo/release-policy";
import {
  loadPersistedRunInput,
  RunInputUnavailable,
} from "#src/backend/services/executions/run-input";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

/**
 * What one pass did with its run.
 *
 * - `ended`: the body wrote the run's terminal record, which deleted the
 *   schedule row and the memo.
 * - `parked`: the body ended with Waits parked. The release re-queued the run
 *   when a park holds a wake the pass did not read, and otherwise put it to
 *   sleep until its earliest park deadline.
 * - `retry`: a step threw, or the body failed outside any step. The release
 *   counted the failure against that step's memo row, or against the run's
 *   own count, and re-queued the run after a backoff.
 * - `retries_spent`: a step threw past its retries. The release made that
 *   step's memo row `failed`, so the next pass fails the step's node and the
 *   rest of the run goes on.
 * - `run_failed`: the run itself has no retries left: its own failure count
 *   passed the limit, or a step outside any node failed past its retries. The
 *   pass wrote the run's terminal record, which deleted the schedule row.
 * - `fence_refused` on `version`: the engine reported a version fence refused
 *   a write, because a Migration moved the run off the version this pass
 *   loaded. The release re-queued it and counted nothing.
 * - `fence_refused` on `owner`: a fenced write found the schedule row no
 *   longer names this pass. Nothing else was written, the release included.
 * - `unavailable`: the run could not be loaded. The pass wrote the terminal
 *   record when the version is missing, deleted the schedule row when the run
 *   is no longer in flight, and wrote nothing for a run that is gone.
 */
export type PassResult =
  | { kind: "ended" }
  | { kind: "parked"; schedule: ReleasedSchedule }
  | { kind: "retry"; error: string; schedule: ReleasedSchedule }
  | { kind: "retries_spent"; stepId: string; schedule: ReleasedSchedule }
  | { kind: "run_failed"; error: string }
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
  /**
   * The wait before a retry, given the failures already counted against what
   * failed. Defaults to `retryBackoffMs`.
   */
  backoffMs?: ((failures: number) => number) | undefined;
};

/** Why a body that did not end on its own stopped, as the release reads it. */
type Failure =
  | { kind: "step"; stepId: string; error: unknown }
  | { kind: "body"; cause: Cause.Cause<unknown> };

export function runPass(
  claimed: ClaimedExecution,
  options: PassOptions
): Effect.Effect<PassResult, DatabaseError, ExecutionRepo | WorkflowRepo> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const { executionId } = claimed;
    const fence = {
      scheduleId: claimed.scheduleId,
      executionId,
      ownerToken: claimed.ownerToken,
    };
    const state = createPassState();
    const fenced = executions.fenced(fence);
    const writes = watchPassWrites({
      fenced,
      unfenced: executions,
      state,
    });
    const leaseExpiresAt = () =>
      new Date(options.now().getTime() + options.leaseMs);
    const backoffMs = options.backoffMs ?? retryBackoffMs;
    const ownerRefused = { kind: "fence_refused", fence: "owner" } as const;

    const release = (outcome: PassOutcome) =>
      writes.releasePass({ outcome, now: options.now() }).pipe(
        Effect.map((released) => ({ owned: true as const, released })),
        Effect.catchTag("LeaseLost", () =>
          Effect.succeed({ owned: false as const })
        )
      );
    const endRunFailed = (error: string) =>
      failRun(writes, executionId, error).pipe(
        Effect.as<PassResult>({ kind: "run_failed", error }),
        Effect.catchTag("LeaseLost", () => Effect.succeed(ownerRefused))
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
      // Nothing will run an ended run again, so its schedule row and memo go.
      if (loaded.reason === "not_in_flight") {
        yield* Effect.ignore(writes.dropSchedule());
      }
      return { kind: "unavailable", reason: loaded.reason } as const;
    }

    if (runRetriesSpent(claimed.attempt)) {
      return yield* endRunFailed(
        "The run's workers stopped renewing its lease too many times"
      );
    }

    const memoEntries = yield* executions.listStepMemo(executionId);
    const memo = new Map<string, StepMemo>(
      memoEntries.map(({ stepId, ...entry }) => [stepId, entry])
    );
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
      memo,
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
      return ownerRefused;
    }

    const failure: Failure | undefined =
      stop?.kind === "step_threw"
        ? { kind: "step", stepId: stop.stepId, error: stop.error }
        : Exit.isFailure(body)
          ? { kind: "body", cause: body.cause }
          : undefined;

    if (failure === undefined) {
      // No step threw and the body raised nothing, so the body's own answer
      // says whether this pass ended the run or parked it.
      if (Exit.isSuccess(body) && body.value.kind === "ended") {
        return { kind: "ended" } as const;
      }
      const parked = yield* release({ kind: "parked" });
      return parked.owned
        ? ({ kind: "parked", schedule: parked.released.schedule } as const)
        : ownerRefused;
    }

    // A step outside any node has no node to fail, so once its retries are
    // spent the body fails on it every pass. The run ends failed instead.
    if (failure.kind === "body") {
      const spent = state.spentStepBehind(
        Option.getOrUndefined(Cause.findErrorOption(failure.cause))
      );
      if (spent !== undefined) {
        return yield* endRunFailed(spent.failure.message);
      }
    }

    const outcome = decideFailedPass({
      failure,
      memo,
      attempt: claimed.attempt,
      backoffMs,
    });
    if (outcome.kind === "run_failed" && runRetriesSpent(claimed.attempt + 1)) {
      return yield* endRunFailed(outcome.error);
    }
    const released = yield* release(outcome);
    if (!released.owned) {
      return ownerRefused;
    }
    return passResultOf(outcome, released.released);
  });
}

/**
 * Writes the run's terminal record as failed with `error`. A run holding a
 * Cancel or Exit claim refuses `failed`, so it ends in the status its claim
 * names instead, carrying the same error.
 */
function failRun(
  writes: FencedExecutionWrites,
  executionId: string,
  error: string
) {
  return Effect.gen(function* () {
    const written = yield* writes.finishRun({
      executionId,
      status: "failed",
      error,
    });
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
    yield* writes.finishRun({
      executionId,
      status: claim.kind === "cancel" ? "canceled" : "exited",
      error,
    });
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
 * the lease to end `leaseMs` from now through the fenced `renewLease`, and
 * record the step the pass is running, so a lease that expires counts against
 * that step.
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
      .renewLease({
        leaseExpiresAt: input.leaseExpiresAt(),
        runningStepId: state.runningStep(),
      })
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
  outcome: Exclude<PassOutcome, { kind: "parked" }>,
  released: ReleasedPass
): PassResult {
  const { schedule } = released;
  if (outcome.kind === "fence_refused") {
    return { kind: "fence_refused", fence: "version", schedule };
  }
  if (
    outcome.kind === "step_failed" &&
    released.countedStep?.status === "failed"
  ) {
    return { kind: "retries_spent", stepId: outcome.stepId, schedule };
  }
  return { kind: "retry", error: outcome.error, schedule };
}

/**
 * The release a failed pass writes. A version fence the engine reports refused
 * is the run having moved, so nothing failed and nothing is counted. A step
 * that threw counts against its own memo row, and its backoff grows with the
 * failures that row holds. A failure no step owns counts against the run.
 */
function decideFailedPass(input: {
  failure: Failure;
  memo: ReadonlyMap<string, StepMemo>;
  attempt: number;
  backoffMs: (failures: number) => number;
}): Exclude<PassOutcome, { kind: "parked" }> {
  const { failure } = input;
  const engineFailure =
    failure.kind === "step"
      ? failureFromUnknown(failure.error)
      : failureFromCause(failure.cause);
  if (engineFailure.kind === "version_refused") {
    return { kind: "fence_refused" };
  }
  if (failure.kind === "step") {
    return {
      kind: "step_failed",
      stepId: failure.stepId,
      error: engineFailure.message,
      backoffMs: input.backoffMs(input.memo.get(failure.stepId)?.failures ?? 0),
    };
  }
  return {
    kind: "run_failed",
    error: engineFailure.message,
    backoffMs: input.backoffMs(input.attempt),
  };
}
