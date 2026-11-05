/**
 * One leased pass over one claimed schedule row: fence every write on the
 * claim's owner token, load the step memo, run the row's body against a replay
 * runtime while a heartbeat renews the lease, and release the row by how the
 * body ended. The caller claims the row first (`ExecutionRepo.claimDue`) and
 * picks the body by the row's `kind`. A pass that loses its lease writes
 * nothing after the write that found it out, its release included.
 */

import { Cause, Clock, Effect, Exit, FiberSet, Option } from "effect";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import {
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";
import { withAppLogCategory } from "#src/backend/lib/effect/app-logger";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
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
import type { RunInputUnavailable } from "#src/backend/services/executions/run-input";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

/**
 * What one pass did with its row.
 *
 * - `ended`: the body wrote the run's terminal record, which deleted the
 *   schedule row and the memo.
 * - `parked`: the body ended with Waits parked. The release re-queued the run
 *   when a park holds a wake the pass did not read, and otherwise put it to
 *   sleep until its earliest park deadline.
 * - `retry`: a step threw, the body failed outside any step, or the write that
 *   ends a row with nothing to run failed. The release counted the failure
 *   against that step's memo row, or against the run's own count, and
 *   re-queued the run after a backoff.
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
 * - `unavailable` with `ending: "written"`: the body had nothing to run, and
 *   the write that ends the row went through. For a run, the pass wrote the
 *   terminal record when the version is missing, deleted the schedule row when
 *   the run is no longer in flight, and wrote nothing for a run whose row is
 *   gone.
 * - `unavailable` with `ending: "failed"`: the database failed that write
 *   with `error`. The release counted a failure against the run and re-queued
 *   it after a backoff, so a later pass tries the write again.
 */
export type PassResult =
  | { kind: "ended" }
  | { kind: "parked"; schedule: ReleasedSchedule }
  | { kind: "retry"; error: string; schedule: ReleasedSchedule }
  | { kind: "retries_spent"; stepId: string; schedule: ReleasedSchedule }
  | { kind: "run_failed"; error: string }
  | { kind: "fence_refused"; fence: "version"; schedule: ReleasedSchedule }
  | { kind: "fence_refused"; fence: "owner" }
  | {
      kind: "unavailable";
      reason: RunInputUnavailable["reason"];
      ending: "written";
    }
  | {
      kind: "unavailable";
      reason: RunInputUnavailable["reason"];
      ending: "failed";
      error: DatabaseError;
      schedule: ReleasedSchedule;
    };

/**
 * How a release went: written, or refused because the schedule row no longer
 * names this pass.
 */
export type PassRelease =
  | { owned: true; released: ReleasedPass }
  | { owned: false };

/** One claimed row with its writes fenced on the claim and watched by `state`. */
export type OpenPass = {
  claimed: ClaimedExecution;
  state: PassState;
  /**
   * The pass's writes. While the pass runs, each is fenced on the owner token
   * and a refusal stops the pass; see `watchPassWrites`.
   */
  writes: FencedExecutionWrites;
  /** Where the lease ends if renewed now, which every memo write renews to. */
  leaseExpiresAt: () => Date;
  /** Every memo row of the claimed run, keyed by step id. */
  loadMemo: Effect.Effect<Map<string, StepMemo>, DatabaseError>;
  /**
   * The replay runtime the body runs against. `runEffect` runs each of the
   * runtime's own reads and writes; the leased pass hands it one tied to the
   * body's scope, so ending the pass interrupts whatever it still runs.
   */
  runtime: (input: {
    memo: ReadonlyMap<string, StepMemo>;
    runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  }) => WorkflowExecutionRuntime;
  /** Writes the release `outcome` decides, stamped with the pass's clock. */
  release: (outcome: PassOutcome) => Effect.Effect<PassRelease, DatabaseError>;
  /**
   * Renews the lease every `everyMs` while the pass still needs it. See
   * `renewLeaseWhileRunning`.
   */
  heartbeat: (everyMs: number) => Effect.Effect<void>;
};

/**
 * Opens a pass over a row the caller just claimed. Nothing is read or written
 * until the caller runs one of the answered Effects.
 */
export function openPass(input: {
  claimed: ClaimedExecution;
  executions: ExecutionRepo["Service"];
  /** The clock every lease, memo and release write is stamped with. */
  now: () => Date;
  /** How long a memo write or a heartbeat renews the lease for. */
  leaseMs: number;
}): OpenPass {
  const { claimed, executions, now, leaseMs } = input;
  const { executionId } = claimed;
  const state = createPassState();
  const fenced = executions.fenced({
    scheduleId: claimed.scheduleId,
    executionId,
    ownerToken: claimed.ownerToken,
  });
  const writes = watchPassWrites({ fenced, unfenced: executions, state });
  const leaseExpiresAt = () => new Date(now().getTime() + leaseMs);

  return {
    claimed,
    state,
    writes,
    leaseExpiresAt,
    loadMemo: executions
      .listStepMemo(executionId)
      .pipe(
        Effect.map(
          (entries) =>
            new Map(entries.map(({ stepId, ...entry }) => [stepId, entry]))
        )
      ),
    runtime: ({ memo, runEffect }) =>
      createExecutorRuntime({
        executionId,
        attempt: claimed.attempt,
        memo,
        writes,
        findPark: executions.findPark,
        state,
        leaseExpiresAt,
        runEffect,
      }),
    release: (outcome) =>
      writes.releasePass({ outcome, now: now() }).pipe(
        Effect.map((released): PassRelease => ({ owned: true, released })),
        Effect.catchTag("LeaseLost", () =>
          Effect.succeed<PassRelease>({ owned: false })
        )
      ),
    heartbeat: (everyMs) =>
      renewLeaseWhileRunning({
        fenced,
        findSchedule: executions.findSchedule,
        executionId,
        state,
        everyMs,
        leaseExpiresAt,
      }),
  };
}

/** How a body that raised nothing ended. */
export type BodyEnd = { kind: "ended" } | { kind: "parked" };

/**
 * What a body's `open` found.
 *
 * - `ready`: `run` runs the body once over the runtime the pass built.
 * - `unavailable`: there is nothing to run. `settle` is the write that ends
 *   the row, such as a terminal record or the schedule row's deletion, which
 *   the pass makes and answers for.
 */
export type OpenedBody<R> =
  | {
      kind: "ready";
      run: (
        runtime: WorkflowExecutionRuntime
      ) => Effect.Effect<BodyEnd, unknown, R>;
    }
  | {
      kind: "unavailable";
      reason: RunInputUnavailable["reason"];
      settle: Effect.Effect<void, DatabaseError | LeaseLost, R>;
    };

/**
 * What a pass runs for one kind of schedule row. The pass owns the lease,
 * the memo, the heartbeat, the release and the retry policy; the body owns
 * what it loads, what it runs, and how its subject ends failed.
 */
export type PassBody<R> = {
  /** Loads what the body runs, writing through the pass's watched writes. */
  open: (pass: OpenPass) => Effect.Effect<OpenedBody<R>, DatabaseError, R>;
  /**
   * Ends the row's subject failed with `error`, for a row whose retries are
   * spent. The write deletes the schedule row.
   */
  fail: (
    pass: OpenPass,
    error: string
  ) => Effect.Effect<void, DatabaseError | LeaseLost, R>;
};

/** The body for each kind of schedule row a claim can lease. */
export type PassBodies<R> = Record<ClaimedExecution["kind"], PassBody<R>>;

export type LeasedPassOptions = {
  /** The worker the claim leased the row to, which the pass's records name. */
  workerId: string;
  /** The clock every lease, memo and release write is stamped with. */
  now: () => Date;
  /** How long a memo write or a heartbeat renews the lease for. */
  leaseMs: number;
  /**
   * How often the lease is renewed while the body runs. Omitted, only a memo
   * write renews it, so a step body that outlasts `leaseMs` loses the lease.
   */
  heartbeatMs?: number | undefined;
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

const OWNER_REFUSED = { kind: "fence_refused", fence: "owner" } as const;

/**
 * Runs one leased pass of `body` over `claimed` and answers what it did. A
 * database failure outside the body leaves the row leased, so a later claim
 * sweeps it once the lease expires.
 */
export const leasedPass = Effect.fn("wfgraph.executor.pass")(function* <R>(
  claimed: ClaimedExecution,
  body: PassBody<R>,
  options: LeasedPassOptions
): Effect.fn.Return<PassResult, DatabaseError, ExecutionRepo | R> {
  yield* Effect.annotateCurrentSpan({
    "wfgraph.execution.id": claimed.executionId,
    "wfgraph.executor.attempt": claimed.attempt,
    "wfgraph.executor.worker": options.workerId,
  });
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* runPassBody(claimed, body, options);
  const finishedAt = yield* Clock.currentTimeMillis;
  yield* logPassRecord({
    claimed,
    workerId: options.workerId,
    ms: finishedAt - startedAt,
    result,
  });
  return result;
}, withExecutorLogCategory);

function withExecutorLogCategory<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return withAppLogCategory(effect, "executor");
}

const runPassBody = Effect.fnUntraced(function* <R>(
  claimed: ClaimedExecution,
  body: PassBody<R>,
  options: LeasedPassOptions
): Effect.fn.Return<PassResult, DatabaseError, ExecutionRepo | R> {
  const executions = yield* ExecutionRepo;
  const pass = openPass({
    claimed,
    executions,
    now: options.now,
    leaseMs: options.leaseMs,
  });
  const backoffMs = options.backoffMs ?? retryBackoffMs;

  const releaseFailed = (outcome: Exclude<PassOutcome, { kind: "parked" }>) =>
    pass
      .release(outcome)
      .pipe(
        Effect.map((release) =>
          release.owned
            ? passResultOf(outcome, release.released)
            : OWNER_REFUSED
        )
      );
  const endFailed = (error: string) =>
    body.fail(pass, error).pipe(
      Effect.as<PassResult>({ kind: "run_failed", error }),
      Effect.catchTag("LeaseLost", () => Effect.succeed(OWNER_REFUSED))
    );

  const opened = yield* body.open(pass);
  if (opened.kind === "unavailable") {
    const { reason } = opened;
    // A row whose ending write failed is released for a retry, so the row is
    // not left leased until its lease runs out.
    return yield* opened.settle.pipe(
      Effect.as<PassResult>({ kind: "unavailable", reason, ending: "written" }),
      Effect.catchTags({
        LeaseLost: () => Effect.succeed(OWNER_REFUSED),
        DatabaseError: (error) =>
          pass
            .release({
              kind: "run_failed",
              error: "The pass could not write the end of a run it cannot load",
              backoffMs: backoffMs(claimed.attempt),
            })
            .pipe(
              Effect.map((release): PassResult =>
                release.owned
                  ? {
                      kind: "unavailable",
                      reason,
                      ending: "failed",
                      error,
                      schedule: release.released.schedule,
                    }
                  : OWNER_REFUSED
              )
            ),
      })
    );
  }

  if (runRetriesSpent(claimed.attempt)) {
    return yield* endFailed(
      "The run's workers stopped renewing its lease too many times"
    );
  }

  const memo = yield* pass.loadMemo;
  const { heartbeatMs } = options;
  // The body's scope holds the fibers that run the runtime's own reads and
  // writes, and the heartbeat. Closing it, when the body ends or the pass is
  // interrupted, interrupts them before the release is written.
  const ran = yield* Effect.scoped(
    Effect.gen(function* () {
      const runEffect = yield* FiberSet.makeRuntimePromise();
      if (heartbeatMs !== undefined) {
        yield* Effect.forkScoped(
          pass
            .heartbeat(heartbeatMs)
            .pipe(
              Effect.annotateLogs(passAnnotations(claimed, options.workerId))
            )
        );
      }
      return yield* Effect.exit(opened.run(pass.runtime({ memo, runEffect })));
    })
  );

  const phase = pass.state.phase();
  const stop = phase.kind === "stopped" ? phase.stop : undefined;
  if (stop?.kind === "lease_lost") {
    return OWNER_REFUSED;
  }

  const failure: Failure | undefined =
    stop?.kind === "step_threw"
      ? { kind: "step", stepId: stop.stepId, error: stop.error }
      : Exit.isFailure(ran)
        ? { kind: "body", cause: ran.cause }
        : undefined;

  if (failure === undefined) {
    // No step threw and the body raised nothing, so the body's own answer
    // says whether this pass ended the run or parked it.
    if (Exit.isSuccess(ran) && ran.value.kind === "ended") {
      return { kind: "ended" };
    }
    const parked = yield* pass.release({ kind: "parked" });
    return parked.owned
      ? { kind: "parked", schedule: parked.released.schedule }
      : OWNER_REFUSED;
  }

  // A step outside any node has no node to fail, so once its retries are
  // spent the body fails on it every pass. The run ends failed instead.
  if (failure.kind === "body") {
    const spent = pass.state.spentStepBehind(
      Option.getOrUndefined(Cause.findErrorOption(failure.cause))
    );
    if (spent !== undefined) {
      return yield* endFailed(spent.failure.message);
    }
  }

  const outcome = decideFailedPass({
    failure,
    memo,
    attempt: claimed.attempt,
    backoffMs,
  });
  if (outcome.kind === "run_failed" && runRetriesSpent(claimed.attempt + 1)) {
    return yield* endFailed(outcome.error);
  }
  return yield* releaseFailed(outcome);
});

/** The log fields that name a pass: its run, its worker and its attempt. */
function passAnnotations(claimed: ClaimedExecution, workerId: string) {
  return {
    run: { execution: claimed.executionId },
    pass: { worker: workerId, attempt: claimed.attempt },
  };
}

/**
 * The pass's one record, written only for an outcome the engine's own run
 * record does not report: a retry, spent retries, a refused fence, or a row
 * with nothing to run. A pass that ended or parked its run leaves the record
 * to the engine.
 */
function logPassRecord(input: {
  claimed: ClaimedExecution;
  workerId: string;
  ms: number;
  result: PassResult;
}): Effect.Effect<void> {
  const { claimed, workerId, ms, result } = input;
  const record = passRecord(result);
  if (record === null) return Effect.void;
  const annotations = passAnnotations(claimed, workerId);
  return Effect.logWithLevel(record.level)(
    "Executor pass did not settle its run"
  ).pipe(
    Effect.annotateLogs(
      omitUndefined({
        ...annotations,
        pass: { ...annotations.pass, ms },
        outcome: record.outcome,
        error: record.error,
      })
    )
  );
}

/** What a pass's record says about its result. */
type PassRecord = {
  level: "Info" | "Warn" | "Error";
  outcome: Record<string, unknown>;
  error?: unknown;
};

/** The record a pass writes for `result`, or null for none. */
function passRecord(result: PassResult): PassRecord | null {
  switch (result.kind) {
    case "retry":
      return {
        level: "Warn",
        outcome: { kind: result.kind, wakeAt: result.schedule.wakeAt },
        error: result.error,
      };
    case "retries_spent":
      return {
        level: "Warn",
        outcome: { kind: result.kind, step: result.stepId },
      };
    case "run_failed":
      return {
        level: "Error",
        outcome: { kind: result.kind },
        error: result.error,
      };
    case "fence_refused":
      return result.fence === "version"
        ? { level: "Info", outcome: { kind: "version_refused" } }
        : { level: "Warn", outcome: { kind: "lease_lost" } };
    case "unavailable":
      return result.ending === "written"
        ? {
            level: "Info",
            outcome: { kind: result.kind, reason: result.reason },
          }
        : {
            level: "Warn",
            outcome: {
              kind: result.kind,
              reason: result.reason,
              wakeAt: result.schedule.wakeAt,
            },
            error: result.error,
          };
    case "ended":
    case "parked":
      break;
  }
  return null;
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
const renewLeaseWhileRunning = Effect.fnUntraced(function* (input: {
  fenced: FencedExecutionWrites;
  findSchedule: ExecutionRepo["Service"]["findSchedule"];
  executionId: string;
  state: PassState;
  everyMs: number;
  leaseExpiresAt: () => Date;
}) {
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
        Effect.annotateLogs({ error }),
        Effect.as("failed" as const)
      )
    ),
    Effect.uninterruptible
  );

  while (needsLease(state)) {
    yield* Effect.sleep(input.everyMs);
    if (!needsLease(state)) return;
    const renewal = yield* beat;
    if (renewal === "refused" || renewal === "run_ended") return;
  }
});

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
