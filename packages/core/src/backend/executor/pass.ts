/**
 * One leased pass over one claimed schedule row: fence every write on the
 * claim's owner token, load the step memo, run the row's body against the
 * port its kind runs through while a heartbeat renews the lease, and release
 * the row by how the body ended. The caller claims the row first
 * (`ExecutionRepo.claimDue`), and `PASS_KINDS` holds what the pass needs to
 * know about each kind of row. What every kind shares, the lease, the memo,
 * the release and the retry policy, is the pass core; a run's pass adds the
 * engine's fenced store writes and its parks on top. A pass that loses its
 * lease writes nothing after the write that found it out, its release
 * included. An interrupted pass releases its row due at once, counting no
 * failure, unless its host's time budget cut it, which counts one against the
 * step it was running.
 */

import { Cause, Clock, Effect, Exit, Fiber, FiberSet, Option } from "effect";
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
  createPassSteps,
  createPassState,
  type PassState,
  type PassStep,
  type PassSteps,
  type RunPassWrites,
  watchParkWrites,
  watchPassOnlyWrites,
  watchStoreWrites,
} from "#src/backend/executor/runtime";
import {
  type ClaimedCron,
  type ClaimedDelivery,
  type ClaimedRun,
  type ClaimedSchedule,
  type CronFence,
  type DeliveryFence,
  ExecutionRepo,
  type PassOutcome,
  type PassWrites,
  type ReleasedPass,
  type ReleasedSchedule,
  type StepMemo,
} from "#src/backend/services/executions/repo";
import {
  retriesSpent,
  retryBackoffMs,
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
 * How loudly the pass's record reports a row with nothing to run: `info` for
 * a row whose subject simply ended elsewhere, `warn` for one the operator
 * should look at, such as a refused payload.
 */
export type UnavailableSeverity = "info" | "warn";

/**
 * What one pass did with its row.
 *
 * - `ended`: the body ended its row's subject: a run's terminal record, or a
 *   delivery's `delivered` inbox row, either of which deleted the schedule row
 *   and the memo, or a cron fire, which moved its timer to the next slot and
 *   released the lease in the same write.
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
 * - `subject_failed`: the row's subject has no retries left: the row's own
 *   failure count passed the limit, or a step outside any node failed past
 *   its retries. The pass ended the subject failed, a run's terminal record or
 *   a delivery's `failed` inbox row, which deleted the schedule row. A cron
 *   timer has no subject to fail, so it skips the slot it was firing instead.
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
 *   row already settled. `severity` and `detail` are what the pass's record
 *   tells the operator.
 * - `unavailable` with `ending: "failed"`: the database failed that write
 *   with `error`. The release counted a failure against the row and re-queued
 *   it after a backoff, so a later pass tries the write again.
 * - `budget_cut`: the pass was still running at `budgetEndsAt`. It was
 *   interrupted, and its release re-queued the row at once and counted one
 *   failure against `stepId`, the step it was running, or nothing when it was
 *   between steps. A release the database failed or did not answer in time
 *   leaves the row leased, and the claim that sweeps it counts that failure.
 */
export type PassResult =
  | { kind: "ended" }
  | { kind: "parked"; schedule: ReleasedSchedule }
  | { kind: "retry"; error: string; schedule: ReleasedSchedule }
  | { kind: "retries_spent"; stepId: string; schedule: ReleasedSchedule }
  | { kind: "subject_failed"; error: string }
  | { kind: "fence_refused"; fence: "version"; schedule: ReleasedSchedule }
  | { kind: "fence_refused"; fence: "owner" }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      ending: "written";
      severity: UnavailableSeverity;
      detail?: string | undefined;
    }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      ending: "failed";
      error: DatabaseError;
      schedule: ReleasedSchedule;
    }
  | { kind: "budget_cut"; stepId: string | null };

/**
 * How a release went: written, or refused because the schedule row no longer
 * names this pass.
 */
export type PassRelease =
  | { owned: true; released: ReleasedPass }
  | { owned: false };

/**
 * What every pass over a claimed row shares, whatever the row runs: the
 * lease, the memo, the release, and `port`, which builds what the body runs
 * its steps through. Each write is fenced on the claim's owner token and
 * watched by `state`.
 */
export type PassCore<C extends ClaimedSchedule, Port> = {
  claimed: C;
  /** The worker the claim leased the row to. */
  workerId: string;
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
   * Builds the port the body runs its steps through, over the memo the pass
   * loaded. `runEffect` runs one of a Promise port's own reads and writes;
   * the leased pass hands it one tied to the body's scope, so ending the pass
   * interrupts whatever it still runs.
   */
  port: (input: {
    memo: ReadonlyMap<string, StepMemo>;
    runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  }) => Port;
  /** Writes the release `outcome` decides, stamped with the pass's clock. */
  release: (outcome: PassOutcome) => Effect.Effect<PassRelease, DatabaseError>;
  /**
   * Renews the lease every `everyMs` while the pass still needs it. See
   * `renewLeaseWhileRunning`.
   */
  heartbeat: (everyMs: number) => Effect.Effect<void>;
};

/** A pass over any kind of claimed row. */
type AnyPass = PassCore<ClaimedSchedule, unknown>;

/**
 * A pass over a claimed `run` row. Its port is the engine's runtime, which
 * parks Waits, and its store writes replay a workflow run.
 */
export type RunPass = PassCore<ClaimedRun, WorkflowExecutionRuntime> & {
  /**
   * The engine's store writes beside the pass's own. While the pass runs, each
   * is fenced on the owner token and on the row still running the claimed
   * Execution, and a refusal stops the pass; see `watchStoreWrites`.
   */
  writes: RunPassWrites;
};

/**
 * A pass over a claimed `delivery` row. Its port runs Effect steps and parks
 * nothing, and `fence` is what the inbox row's settling write carries.
 */
export type DeliveryPass = PassCore<ClaimedDelivery, PassSteps> & {
  fence: DeliveryFence;
};

/**
 * A pass over a claimed `cron` row. A fire runs no steps, so its port is
 * null, and `fence` is what the fire's one transaction carries.
 */
export type CronPass = PassCore<ClaimedCron, null> & { fence: CronFence };

type PassOpening = {
  executions: ExecutionRepo["Service"];
  /** The worker the claim leased the row to. */
  workerId: string;
  /** The clock every lease, memo and release write is stamped with. */
  now: () => Date;
  /** How long a memo write or a heartbeat renews the lease for. */
  leaseMs: number;
};

/**
 * Opens the core of a pass over a row the caller just claimed, over `fenced`,
 * the pass's own writes fenced on the claim. `port` builds the body's port
 * from the memo and the pass's watched writes. Nothing is read or written
 * until the caller runs one of the answered Effects.
 */
function openPassCore<C extends ClaimedSchedule, Port>(
  input: PassOpening & {
    claimed: C;
    fenced: PassWrites;
    port: (input: {
      memo: ReadonlyMap<string, StepMemo>;
      runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
      state: PassState;
      passWrites: PassWrites;
      leaseExpiresAt: () => Date;
    }) => Port;
  }
): PassCore<C, Port> {
  const { claimed, executions, now, leaseMs } = input;
  const state = createPassState();
  const passWrites = watchPassOnlyWrites({ fenced: input.fenced, state });
  const leaseExpiresAt = () => new Date(now().getTime() + leaseMs);

  return {
    claimed,
    workerId: input.workerId,
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
    port: ({ memo, runEffect }) =>
      input.port({ memo, runEffect, state, passWrites, leaseExpiresAt }),
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
    port: ({ memo, runEffect, state, passWrites, leaseExpiresAt }) =>
      createExecutorRuntime({
        memo,
        writeStepMemo: passWrites.writeStepMemo,
        parks: {
          findPark: executions.findPark,
          ...watchParkWrites({ fenced, state }),
        },
        state,
        leaseExpiresAt,
        runEffect,
      }),
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
    fenced: executions.fencedPass(fence),
    port: ({ memo, state, passWrites, leaseExpiresAt }) =>
      createPassSteps({
        memo,
        writeStepMemo: passWrites.writeStepMemo,
        state,
        leaseExpiresAt,
      }),
  });
  return { ...core, fence };
}

/** Opens a pass over a `cron` row the caller just claimed. */
export function openCronPass(
  input: PassOpening & { claimed: ClaimedCron }
): CronPass {
  const { claimed, executions } = input;
  const fence: CronFence = {
    scheduleId: claimed.scheduleId,
    workflowId: claimed.workflowId,
    ownerToken: claimed.ownerToken,
  };
  const core = openPassCore({
    ...input,
    fenced: executions.fencedPass(fence),
    port: () => null,
  });
  return { ...core, fence };
}

/** How a body that raised nothing ended. */
export type BodyEnd = { kind: "ended" } | { kind: "parked" };

/**
 * What a body's `open` found.
 *
 * - `ready`: `run` runs the body once over the port the pass built.
 * - `unavailable`: there is nothing to run. `settle` is the write that ends
 *   the row, such as a terminal record, a failed inbox row or the schedule
 *   row's deletion, which the pass makes and answers for. `severity` and
 *   `detail` are what the pass's record tells the operator about why.
 */
export type OpenedBody<Port, R> =
  | {
      kind: "ready";
      run: (port: Port) => Effect.Effect<BodyEnd, unknown, R>;
    }
  | {
      kind: "unavailable";
      reason: UnavailableReason;
      severity: UnavailableSeverity;
      settle: Effect.Effect<void, DatabaseError | LeaseLost, R>;
      detail?: string | undefined;
    };

/** The port a pass hands its body. */
type PortOf<P> = P extends PassCore<ClaimedSchedule, infer Port> ? Port : never;

/** `PassBody`, with the port its pass hands it spelled out. */
type BodyOver<P, Port, R> = {
  /** Loads what the body runs, writing through the pass's watched writes. */
  open: (pass: P) => Effect.Effect<OpenedBody<Port, R>, DatabaseError, R>;
  /**
   * Ends the row's subject failed with `error`, for a row whose retries are
   * spent. The write deletes a run's or a delivery's schedule row, and moves
   * a cron timer on to its next slot.
   */
  fail: (
    pass: P,
    error: string
  ) => Effect.Effect<void, DatabaseError | LeaseLost, R>;
};

/**
 * What a pass runs for one kind of schedule row. The pass owns the lease,
 * the memo, the heartbeat, the release and the retry policy; the body owns
 * what it loads, what it runs, and how its subject ends failed.
 */
export type PassBody<P, R> = BodyOver<P, PortOf<P>, R>;

/** What kind of row a claim leased. */
type ScheduleKind = ClaimedSchedule["kind"];

/** The claimed row of one kind. */
type ClaimedOf<K extends ScheduleKind> = Extract<ClaimedSchedule, { kind: K }>;

/** The pass a claimed row of one kind opens. */
type PassOf<K extends ScheduleKind> = K extends "run"
  ? RunPass
  : K extends "delivery"
    ? DeliveryPass
    : K extends "cron"
      ? CronPass
      : never;

/** The body for each kind of schedule row a claim can lease. */
export type PassBodies<R> = {
  readonly [K in ScheduleKind]: PassBody<PassOf<K>, R>;
};

/** What a pass needs to know about one kind of schedule row. */
type PassKind<K extends ScheduleKind> = {
  /**
   * Opens the pass over a row of this kind the caller just claimed, and runs
   * the body `bodies` names for the kind to a release.
   */
  run: <R>(
    opening: PassOpening & { claimed: ClaimedOf<K> },
    bodies: PassBodies<R>,
    options: LeasedPassOptions
  ) => Effect.Effect<PassResult, DatabaseError, R>;
  /** The span attributes that name the row's subject. */
  spanAttributes: (claimed: ClaimedOf<K>) => Record<string, string>;
  /** The log group that names the row's subject. */
  logSubject: (claimed: ClaimedOf<K>) => Record<string, Record<string, string>>;
};

/**
 * One descriptor per kind of schedule row. A kind added to `ClaimedSchedule`
 * fails to compile here, in `PassOf` and in `withPassKind` until it has an
 * entry in each.
 */
const PASS_KINDS: { readonly [K in ScheduleKind]: PassKind<K> } = {
  run: {
    run: (opening, bodies, options) =>
      runOpenedPass(openRunPass(opening), bodies.run, options),
    spanAttributes: (claimed) => ({
      "wfgraph.execution.id": claimed.executionId,
    }),
    logSubject: (claimed) => ({ run: { execution: claimed.executionId } }),
  },
  delivery: {
    run: (opening, bodies, options) =>
      runOpenedPass(openDeliveryPass(opening), bodies.delivery, options),
    spanAttributes: (claimed) => ({ "wfgraph.inbox.id": claimed.inboxId }),
    logSubject: (claimed) => ({ delivery: { inbox: claimed.inboxId } }),
  },
  cron: {
    // A fire is one preflight and one short transaction, well inside a lease,
    // so its pass renews no lease. A renewal would race the fire's own
    // release of the lease and read that release as a lease lost.
    run: (opening, bodies, options) =>
      runOpenedPass(openCronPass(opening), bodies.cron, {
        ...options,
        heartbeatMs: undefined,
      }),
    spanAttributes: (claimed) => ({
      "wfgraph.workflow.id": claimed.workflowId,
    }),
    logSubject: (claimed) => ({
      cron: {
        workflow: claimed.workflowId,
        expression: claimed.schedule.cron,
        timeZone: claimed.schedule.timeZone,
      },
    }),
  },
};

/** Calls `apply` with the descriptor of `claimed`'s kind and the row itself. */
function withPassKind<A>(
  claimed: ClaimedSchedule,
  apply: <K extends ScheduleKind>(kind: PassKind<K>, claimed: ClaimedOf<K>) => A
): A {
  switch (claimed.kind) {
    case "run":
      return apply(PASS_KINDS.run, claimed);
    case "delivery":
      return apply(PASS_KINDS.delivery, claimed);
    case "cron":
      return apply(PASS_KINDS.cron, claimed);
    default:
      return unknownKind(claimed);
  }
}

function unknownKind(claimed: never): never {
  throw new Error(`No pass runs a schedule row of kind ${String(claimed)}`);
}

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
  /**
   * When the host's time budget for this pass runs out, such as the end of a
   * Worker tick. A pass still running then is interrupted and answers
   * `budget_cut`. Omitted, the pass runs until its body ends or its caller
   * interrupts it, which releases its row as a graceful drain.
   */
  budgetEndsAt?: Date | undefined;
};

/**
 * How long an interrupted pass waits for its release, so a database that
 * stopped answering cannot hold a stopping worker past its platform's limit.
 */
const INTERRUPTED_RELEASE_TIMEOUT_MS = 10_000;

/** Why a body that did not end on its own stopped, as the release reads it. */
type Failure =
  | { kind: "step"; step: PassStep; error: unknown }
  | { kind: "body"; cause: Cause.Cause<unknown> };

const OWNER_REFUSED = { kind: "fence_refused", fence: "owner" } as const;

/**
 * Runs one leased pass over `claimed` with the body `bodies` names for its
 * kind, and answers what it did. A database failure outside the body leaves
 * the row leased, so a later claim sweeps it once the lease expires. An
 * interrupted pass releases its row as `interrupted` before the interruption
 * completes: a worker that stops gracefully spends no retry of the step it
 * was running, and a pass its `budgetEndsAt` cut spends one.
 */
export const leasedPass = Effect.fn("wfgraph.executor.pass")(function* <R>(
  claimed: ClaimedSchedule,
  bodies: PassBodies<R>,
  options: LeasedPassOptions
): Effect.fn.Return<PassResult, DatabaseError, ExecutionRepo | R> {
  yield* Effect.annotateCurrentSpan({
    "wfgraph.executor.schedule": claimed.scheduleId,
    "wfgraph.executor.kind": claimed.kind,
    ...withPassKind(claimed, (kind, row) => kind.spanAttributes(row)),
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
    workerId: options.workerId,
    now: options.now,
    leaseMs: options.leaseMs,
  };
  return yield* withPassKind(claimed, (kind, row) =>
    kind.run({ ...opening, claimed: row }, bodies, options)
  );
});

/**
 * Runs the opened pass to its release. An interruption from the caller
 * releases the row as a graceful drain. With `budgetEndsAt`, the pass runs in
 * a fiber of its own, and one still running at that moment has the step it is
 * running read before it is interrupted, since interrupting an Effect step
 * marks the step finished. Its release then counts a failure against that
 * step.
 */
function runOpenedPass<Port, P extends PassCore<ClaimedSchedule, Port>, R>(
  pass: P,
  body: BodyOver<P, Port, R>,
  options: LeasedPassOptions
): Effect.Effect<PassResult, DatabaseError, R> {
  let interruption: Extract<PassOutcome, { kind: "interrupted" }> = {
    kind: "interrupted",
    by: "drain",
  };
  const settled = settlePass(pass, body, options).pipe(
    Effect.onInterrupt(() =>
      Effect.suspend(() => releaseInterrupted(pass, interruption))
    )
  );
  const { budgetEndsAt } = options;
  if (budgetEndsAt === undefined) return settled;
  return Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(settled);
      const exit = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOrElse({
          duration: Math.max(
            0,
            budgetEndsAt.getTime() - options.now().getTime()
          ),
          orElse: () => Effect.undefined,
        })
      );
      if (exit !== undefined) return yield* exit;
      const running = pass.state.runningStep();
      const stepId = running?.stepId ?? null;
      interruption = {
        kind: "interrupted",
        by: "budget",
        stepId,
        nodeId: running?.nodeId ?? null,
      };
      yield* Fiber.interrupt(fiber);
      const cut: PassResult = { kind: "budget_cut", stepId };
      return cut;
    })
  );
}

/**
 * Hands an interrupted pass's row back, due at once, counting what
 * `interruption` says to. A pass that already released its row, ended its
 * subject or lost its lease finds the fence refused, and writes nothing. A
 * release the database fails, or does not answer within
 * `INTERRUPTED_RELEASE_TIMEOUT_MS`, is logged, and the row is swept once its
 * lease expires.
 */
function releaseInterrupted(
  pass: AnyPass,
  interruption: Extract<PassOutcome, { kind: "interrupted" }>
): Effect.Effect<void> {
  const notReleased = (error: unknown) =>
    Effect.logWarning(
      "Could not release an interrupted pass; its row is claimed again once its lease expires"
    ).pipe(
      Effect.annotateLogs({
        ...subjectAnnotation(pass.claimed),
        interruption: { by: interruption.by },
        error,
      })
    );
  // Interruptible, so the timeout can abandon a write the database never
  // answers even though an interruption's finalizer runs uninterruptibly.
  return Effect.interruptible(pass.release(interruption)).pipe(
    Effect.asVoid,
    Effect.catchTag("DatabaseError", notReleased),
    Effect.timeoutOrElse({
      duration: INTERRUPTED_RELEASE_TIMEOUT_MS,
      orElse: () =>
        notReleased(`no answer within ${INTERRUPTED_RELEASE_TIMEOUT_MS} ms`),
    })
  );
}

/** Runs the opened pass's body and writes the release its ending decides. */
const settlePass = Effect.fnUntraced(function* <
  Port,
  P extends PassCore<ClaimedSchedule, Port>,
  R,
>(
  pass: P,
  body: BodyOver<P, Port, R>,
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
      Effect.as<PassResult>({ kind: "subject_failed", error }),
      Effect.catchTag("LeaseLost", () => Effect.succeed(OWNER_REFUSED))
    );

  const opened = yield* body.open(pass);
  if (opened.kind === "unavailable") {
    const { reason, severity, detail } = opened;
    // A row whose ending write failed is released for a retry, so the row is
    // not left leased until its lease runs out.
    return yield* opened.settle.pipe(
      Effect.as<PassResult>({
        kind: "unavailable",
        reason,
        ending: "written",
        severity,
        detail,
      }),
      Effect.catchTags({
        LeaseLost: () => Effect.succeed(OWNER_REFUSED),
        DatabaseError: (error) =>
          pass
            .release({
              kind: "body_failed",
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

  if (retriesSpent(claimed.attempt)) {
    return yield* endFailed(
      "The workers running it stopped renewing their lease too many times"
    );
  }

  const memo = yield* pass.loadMemo;
  const { heartbeatMs } = options;
  // The body's scope holds the fibers that run a Promise port's own reads and
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
      return yield* Effect.exit(opened.run(pass.port({ memo, runEffect })));
    })
  );

  const phase = pass.state.phase();
  const stop = phase.kind === "stopped" ? phase.stop : undefined;
  if (stop?.kind === "lease_lost") {
    return OWNER_REFUSED;
  }

  const failure: Failure | undefined =
    stop?.kind === "step_threw"
      ? { kind: "step", step: stop.step, error: stop.error }
      : Exit.isFailure(ran)
        ? { kind: "body", cause: ran.cause }
        : undefined;

  if (failure === undefined) {
    // No step threw and the body raised nothing, so the body's own answer
    // says whether this pass ended its subject or parked it.
    if (Exit.isSuccess(ran) && ran.value.kind === "ended") {
      return { kind: "ended" };
    }
    const parked = yield* pass.release({ kind: "parked" });
    return parked.owned
      ? { kind: "parked", schedule: parked.released.schedule }
      : OWNER_REFUSED;
  }

  // A step outside any node has no node to fail, so once its retries are
  // spent the body fails on it every pass. The subject ends failed instead.
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
  if (outcome.kind === "body_failed" && retriesSpent(claimed.attempt + 1)) {
    return yield* endFailed(outcome.error);
  }
  return yield* releaseFailed(outcome);
});

/** The log group that names what a claimed row runs. */
function subjectAnnotation(claimed: ClaimedSchedule) {
  return withPassKind(claimed, (kind, row) => kind.logSubject(row));
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
 * do not report: a retry, spent retries, a refused fence, a row with nothing
 * to run, or a budget cut. A pass that ended or parked its row leaves the record to the
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

const RECORD_LEVEL: Record<UnavailableSeverity, PassRecord["level"]> = {
  info: "Info",
  warn: "Warn",
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
    case "subject_failed":
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
            level: RECORD_LEVEL[result.severity],
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
    case "budget_cut":
      return {
        level: "Warn",
        outcome: omitUndefined({
          kind: result.kind,
          step: result.stepId ?? undefined,
        }),
      };
    case "ended":
    case "parked":
      break;
  }
  return null;
}

/**
 * Whether the pass still owes its row a release, and so still needs its
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
 * the fence refused it with the row still scheduled, or the fence refused it
 * because the schedule row is gone.
 */
type Beat = "renewed" | "failed" | "refused" | "subject_ended";

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
    const running = state.runningStep();
    const renewal = yield* input
      .renewLease({
        leaseExpiresAt: input.leaseExpiresAt(),
        runningStepId: running?.stepId ?? null,
        runningNodeId: running?.nodeId ?? null,
      })
      .pipe(
        Effect.as("renewed" as const),
        Effect.catchTag("LeaseLost", () => Effect.succeed("refused" as const))
      );
    if (renewal === "renewed") return renewal;
    if ((yield* input.findSchedule({ scheduleId })) === null) {
      return "subject_ended" as const;
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
    if (renewal === "refused" || renewal === "subject_ended") return;
  }
});

/** The outcomes of a pass whose body failed. */
type FailedPassOutcome = Extract<
  PassOutcome,
  { kind: "step_failed" | "body_failed" | "fence_refused" }
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
 * failures that row holds. A failure no step owns counts against the row.
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
    const { stepId, nodeId } = failure.step;
    return {
      kind: "step_failed",
      stepId,
      nodeId,
      error: engineFailure.message,
      backoffMs: input.backoffMs(input.memo.get(stepId)?.failures ?? 0),
    };
  }
  return {
    kind: "body_failed",
    error: engineFailure.message,
    backoffMs: input.backoffMs(input.attempt),
  };
}
