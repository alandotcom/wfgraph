/**
 * One leased pass over one claimed schedule row: fence every write on the
 * claim's owner token, load the step memo, run the row's body against a replay
 * runtime while a heartbeat renews the lease, and release the row by how the
 * body ended. The caller claims the row first (`ExecutionRepo.claimDue`), and
 * the pass picks the body by the row's `kind`. What every kind shares, the
 * lease, the memo, the release and the retry policy, is the pass core; a run's
 * pass adds the engine's fenced store writes on top. A pass that loses its
 * lease writes nothing after the write that found it out, its release
 * included. An interrupted pass releases its row due at once, counting no
 * failure.
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
  type ParkAccess,
  type PassState,
  watchPassOnlyWrites,
  watchStoreWrites,
} from "#src/backend/executor/runtime";
import {
  type ClaimedDelivery,
  type ClaimedRun,
  type ClaimedSchedule,
  type DeliveryFence,
  ExecutionRepo,
  type FencedExecutionWrites,
  type PassOutcome,
  type PassWrites,
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
 * Why a body had nothing to run. A run's reasons are `RunInputUnavailable`'s.
 * A delivery's inbox row is gone or already settled, names no catalog Event or
 * source, names a source whose Events' `source.when` filters all pass over its
 * data, or carries a payload its Event refuses.
 */
export type UnavailableReason =
  | RunInputUnavailable["reason"]
  | "missing_inbox_event"
  | "inbox_event_settled"
  | "unknown_event"
  | "unmatched_source"
  | "payload_refused";

/**
 * What one pass did with its row.
 *
 * - `ended`: the body ended its row's subject: a run's terminal record, or a
 *   delivery's `delivered` inbox row. Either write deleted the schedule row
 *   and the memo.
 * - `parked`: the body ended with Waits parked. The release re-queued the run
 *   when a park holds a wake the pass did not read, and otherwise put it to
 *   sleep until its earliest park deadline.
 * - `retry`: a step threw, the body failed outside any step, or the write that
 *   ends a row with nothing to run failed. The release counted the failure
 *   against that step's memo row, or against the row's own count, and
 *   re-queued the row after a backoff.
 * - `retries_spent`: a step threw past its retries. The release made that
 *   step's memo row `failed`, so the next pass fails the step's node and the
 *   rest of the run goes on, or fails the delivery.
 * - `run_failed`: the row's subject has no retries left: the row's own failure
 *   count passed the limit, or a step outside any node failed past its
 *   retries. The pass ended the subject failed, a run's terminal record or a
 *   delivery's `failed` inbox row, which deleted the schedule row.
 * - `fence_refused` on `version`: the engine reported a version fence refused
 *   a write, because a Migration moved the run off the version this pass
 *   loaded. The release re-queued it and counted nothing.
 * - `fence_refused` on `owner`: a fenced write found the schedule row no
 *   longer names this pass. Nothing else was written, the release included.
 * - `unavailable` with `ending: "written"`: the body had nothing to run, and
 *   the write that ends the row went through. For a run, the pass wrote the
 *   terminal record when the version is missing, deleted the schedule row when
 *   the run is no longer in flight, and wrote nothing for a run whose row is
 *   gone. For a delivery, the pass marked the inbox row `failed` when it names
 *   no Event or its payload is refused, marked it `delivered` when no Event on
 *   the source it names accepts its data, and deleted the schedule row of a
 *   row already settled. `detail` is what the pass's record tells the
 *   operator.
 * - `unavailable` with `ending: "failed"`: the database failed that write
 *   with `error`. The release counted a failure against the row and re-queued
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
      reason: UnavailableReason;
      ending: "written";
      detail?: string | undefined;
    }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
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

/**
 * What every pass over a claimed row shares, whatever the row runs: the
 * lease, the memo, the step runtime and the release, each fenced on the
 * claim's owner token and watched by `state`.
 */
export type PassCore<C extends ClaimedSchedule> = {
  claimed: C;
  state: PassState;
  /** The pass's own writes, each watched by `state`; see `watchPassOnlyWrites`. */
  passWrites: PassWrites;
  /** The clock every lease, memo and release write is stamped with. */
  now: () => Date;
  /** Where the lease ends if renewed now, which every memo write renews to. */
  leaseExpiresAt: () => Date;
  /** Every memo row of the claimed schedule row, keyed by step id. */
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
 * A pass over a claimed `run` row. Its runtime parks Waits, and its store
 * writes replay a workflow run.
 */
export type RunPass = PassCore<ClaimedRun> & {
  /**
   * The engine's store writes beside the pass's own. While the pass runs, each
   * is fenced on the owner token and on the row still running the claimed
   * Execution, and a refusal stops the pass; see `watchStoreWrites`.
   */
  writes: FencedExecutionWrites;
};

/**
 * A pass over a claimed `delivery` row. Its runtime runs steps and parks
 * nothing, and `fence` is what the inbox row's settling write carries.
 */
export type DeliveryPass = PassCore<ClaimedDelivery> & {
  fence: DeliveryFence;
};

type PassOpening = {
  executions: ExecutionRepo["Service"];
  /** The clock every lease, memo and release write is stamped with. */
  now: () => Date;
  /** How long a memo write or a heartbeat renews the lease for. */
  leaseMs: number;
};

/**
 * Opens the core of a pass over a row the caller just claimed, over `fenced`,
 * the pass's own writes fenced on the claim. `findPark` gives the runtime its
 * Waits; a pass that parks nothing leaves it out. Nothing is read or written
 * until the caller runs one of the answered Effects.
 */
function openPassCore<C extends ClaimedSchedule>(
  input: PassOpening & {
    claimed: C;
    fenced: PassWrites;
    findPark?: ParkAccess["findPark"] | undefined;
  }
): PassCore<C> {
  const { claimed, executions, now, leaseMs, findPark } = input;
  const state = createPassState();
  const passWrites = watchPassOnlyWrites({ fenced: input.fenced, state });
  const leaseExpiresAt = () => new Date(now().getTime() + leaseMs);
  const parks: ParkAccess | undefined =
    findPark === undefined
      ? undefined
      : { findPark, recordParkStep: passWrites.recordParkStep };

  return {
    claimed,
    state,
    passWrites,
    now,
    leaseExpiresAt,
    loadMemo: executions
      .listStepMemo({ scheduleId: claimed.scheduleId })
      .pipe(
        Effect.map(
          (entries) =>
            new Map(entries.map(({ stepId, ...entry }) => [stepId, entry]))
        )
      ),
    runtime: ({ memo, runEffect }) =>
      createExecutorRuntime({
        memo,
        writeStepMemo: passWrites.writeStepMemo,
        parks,
        state,
        leaseExpiresAt,
        runEffect,
      }),
    release: (outcome) =>
      passWrites.releasePass({ outcome, now: now() }).pipe(
        Effect.map((released): PassRelease => ({ owned: true, released })),
        Effect.catchTag("LeaseLost", () =>
          Effect.succeed<PassRelease>({ owned: false })
        )
      ),
    heartbeat: (everyMs) =>
      renewLeaseWhileRunning({
        renewLease: input.fenced.renewLease,
        findSchedule: executions.findSchedule,
        scheduleId: claimed.scheduleId,
        state,
        everyMs,
        leaseExpiresAt,
      }),
  };
}

/** Opens a pass over a `run` row the caller just claimed. */
export function openRunPass(
  input: PassOpening & { claimed: ClaimedRun }
): RunPass {
  const { claimed, executions } = input;
  const fenced = executions.fenced({
    scheduleId: claimed.scheduleId,
    executionId: claimed.executionId,
    ownerToken: claimed.ownerToken,
  });
  const core = openPassCore({
    ...input,
    fenced,
    findPark: executions.findPark,
  });
  return {
    ...core,
    writes: watchStoreWrites({
      fenced,
      unfenced: executions,
      passWrites: core.passWrites,
      state: core.state,
    }),
  };
}

/** Opens a pass over a `delivery` row the caller just claimed. */
export function openDeliveryPass(
  input: PassOpening & { claimed: ClaimedDelivery }
): DeliveryPass {
  const { claimed, executions } = input;
  const fence: DeliveryFence = {
    scheduleId: claimed.scheduleId,
    inboxId: claimed.inboxId,
    ownerToken: claimed.ownerToken,
  };
  const core = openPassCore({
    ...input,
    fenced: executions.fencedDelivery(fence),
  });
  return { ...core, fence };
}

/** How a body that raised nothing ended. */
export type BodyEnd = { kind: "ended" } | { kind: "parked" };

/**
 * What a body's `open` found.
 *
 * - `ready`: `run` runs the body once over the runtime the pass built.
 * - `unavailable`: there is nothing to run. `settle` is the write that ends
 *   the row, such as a terminal record, a failed inbox row or the schedule
 *   row's deletion, which the pass makes and answers for. `detail` is what
 *   the pass's record tells the operator about why.
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
      reason: UnavailableReason;
      settle: Effect.Effect<void, DatabaseError | LeaseLost, R>;
      detail?: string | undefined;
    };

/**
 * What a pass runs for one kind of schedule row. The pass owns the lease,
 * the memo, the heartbeat, the release and the retry policy; the body owns
 * what it loads, what it runs, and how its subject ends failed.
 */
export type PassBody<P, R> = {
  /** Loads what the body runs, writing through the pass's watched writes. */
  open: (pass: P) => Effect.Effect<OpenedBody<R>, DatabaseError, R>;
  /**
   * Ends the row's subject failed with `error`, for a row whose retries are
   * spent. The write deletes the schedule row.
   */
  fail: (
    pass: P,
    error: string
  ) => Effect.Effect<void, DatabaseError | LeaseLost, R>;
};

/** The body for each kind of schedule row a claim can lease. */
export type PassBodies<R> = {
  run: PassBody<RunPass, R>;
  delivery: PassBody<DeliveryPass, R>;
};

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
 * Runs one leased pass over `claimed` with the body `bodies` names for its
 * kind, and answers what it did. A database failure outside the body leaves
 * the row leased, so a later claim sweeps it once the lease expires. An
 * interrupted pass releases its row as `interrupted` before the interruption
 * completes, so a worker that stops gracefully spends no retry of the step it
 * was running.
 */
export const leasedPass = Effect.fn("wfgraph.executor.pass")(function* <R>(
  claimed: ClaimedSchedule,
  bodies: PassBodies<R>,
  options: LeasedPassOptions
): Effect.fn.Return<PassResult, DatabaseError, ExecutionRepo | R> {
  yield* Effect.annotateCurrentSpan({
    "wfgraph.executor.schedule": claimed.scheduleId,
    "wfgraph.executor.kind": claimed.kind,
    ...(claimed.kind === "run"
      ? { "wfgraph.execution.id": claimed.executionId }
      : { "wfgraph.inbox.id": claimed.inboxId }),
    "wfgraph.executor.attempt": claimed.attempt,
    "wfgraph.executor.worker": options.workerId,
  });
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* runPassBody(claimed, bodies, options);
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

/** Opens the pass `claimed`'s kind calls for and runs its body to a release. */
const runPassBody = Effect.fnUntraced(function* <R>(
  claimed: ClaimedSchedule,
  bodies: PassBodies<R>,
  options: LeasedPassOptions
): Effect.fn.Return<PassResult, DatabaseError, ExecutionRepo | R> {
  const opening: PassOpening = {
    executions: yield* ExecutionRepo,
    now: options.now,
    leaseMs: options.leaseMs,
  };
  if (claimed.kind === "run") {
    return yield* runOpenedPass(
      openRunPass({ ...opening, claimed }),
      bodies.run,
      options
    );
  }
  return yield* runOpenedPass(
    openDeliveryPass({ ...opening, claimed }),
    bodies.delivery,
    options
  );
});

function runOpenedPass<P extends PassCore<ClaimedSchedule>, R>(
  pass: P,
  body: PassBody<P, R>,
  options: LeasedPassOptions
): Effect.Effect<PassResult, DatabaseError, R> {
  return settlePass(pass, body, options).pipe(
    Effect.onInterrupt(() => releaseInterrupted(pass))
  );
}

/**
 * Hands an interrupted pass's row back, due at once and counting nothing. A
 * pass that already released its row, ended its subject or lost its lease
 * finds the fence refused, and writes nothing. A release the database fails is
 * logged, and the row is swept once its lease expires.
 */
function releaseInterrupted(
  pass: PassCore<ClaimedSchedule>
): Effect.Effect<void> {
  return pass.release({ kind: "interrupted" }).pipe(
    Effect.asVoid,
    Effect.catchTag("DatabaseError", (error) =>
      Effect.logWarning(
        "Could not release an interrupted pass; its row is claimed again once its lease expires"
      ).pipe(Effect.annotateLogs({ ...subjectAnnotation(pass.claimed), error }))
    )
  );
}

/** Runs the opened pass's body and writes the release its ending decides. */
const settlePass = Effect.fnUntraced(function* <
  P extends PassCore<ClaimedSchedule>,
  R,
>(
  pass: P,
  body: PassBody<P, R>,
  options: LeasedPassOptions
): Effect.fn.Return<PassResult, DatabaseError, R> {
  const { claimed } = pass;
  const backoffMs = options.backoffMs ?? retryBackoffMs;

  const releaseFailed = (outcome: FailedPassOutcome) =>
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
    const { reason, detail } = opened;
    // A row whose ending write failed is released for a retry, so the row is
    // not left leased until its lease runs out.
    return yield* opened.settle.pipe(
      Effect.as<PassResult>({
        kind: "unavailable",
        reason,
        ending: "written",
        detail,
      }),
      Effect.catchTags({
        LeaseLost: () => Effect.succeed(OWNER_REFUSED),
        DatabaseError: (error) =>
          pass
            .release({
              kind: "run_failed",
              error: "The pass could not write the end of a row it cannot run",
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
      "The workers running it stopped renewing their lease too many times"
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

/**
 * The log field that names what a claimed row runs: for a `run` row its
 * Execution, and for a `delivery` row its inbox row.
 */
function subjectAnnotation(claimed: ClaimedSchedule) {
  return claimed.kind === "run"
    ? { run: { execution: claimed.executionId } }
    : { delivery: { inbox: claimed.inboxId } };
}

/**
 * The log fields that name a pass: its schedule row, its worker, its attempt,
 * and what the row runs.
 */
export function passAnnotations(claimed: ClaimedSchedule, workerId: string) {
  return {
    ...subjectAnnotation(claimed),
    pass: {
      schedule: claimed.scheduleId,
      worker: workerId,
      attempt: claimed.attempt,
    },
  };
}

/**
 * The pass's one record, written only for an outcome the body's own records
 * do not report: a retry, spent retries, a refused fence, or a row with
 * nothing to run. A pass that ended or parked its row leaves the record to the
 * engine's run record or the delivery's own.
 */
function logPassRecord(input: {
  claimed: ClaimedSchedule;
  workerId: string;
  ms: number;
  result: PassResult;
}): Effect.Effect<void> {
  const { claimed, workerId, ms, result } = input;
  const record = passRecord(result);
  if (record === null) return Effect.void;
  const annotations = passAnnotations(claimed, workerId);
  return Effect.logWithLevel(record.level)(
    "Executor pass did not settle its row"
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
            level: result.detail === undefined ? "Info" : "Warn",
            outcome: { kind: result.kind, reason: result.reason },
            error: result.detail,
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
 * finds the schedule row gone: the row's subject has ended, and when it was
 * this pass's own ending write the pass must keep the phase that write set, so
 * the heartbeat stops and leaves it alone. A renewal the database fails is
 * logged and tried again on the next beat. Each renewal is uninterruptible, so
 * the interrupt at the end of the body waits for one already sent.
 */
const renewLeaseWhileRunning = Effect.fnUntraced(function* (input: {
  renewLease: PassWrites["renewLease"];
  findSchedule: ExecutionRepo["Service"]["findSchedule"];
  scheduleId: string;
  state: PassState;
  everyMs: number;
  leaseExpiresAt: () => Date;
}) {
  const { state, scheduleId } = input;
  const beat: Effect.Effect<Beat> = Effect.gen(function* () {
    const renewal = yield* input
      .renewLease({
        leaseExpiresAt: input.leaseExpiresAt(),
        runningStepId: state.runningStep(),
      })
      .pipe(
        Effect.as("renewed" as const),
        Effect.catchTag("LeaseLost", () => Effect.succeed("refused" as const))
      );
    if (renewal === "renewed") return renewal;
    if ((yield* input.findSchedule({ scheduleId })) === null) {
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

/** The outcomes of a pass whose body failed. */
type FailedPassOutcome = Extract<
  PassOutcome,
  { kind: "step_failed" | "run_failed" | "fence_refused" }
>;

/** What a failed pass answers for the release it wrote. */
function passResultOf(
  outcome: FailedPassOutcome,
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
}): FailedPassOutcome {
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
