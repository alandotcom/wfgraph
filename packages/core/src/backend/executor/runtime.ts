/**
 * The ports a database executor pass runs its body through, over the step
 * memo it loaded when it claimed its schedule row.
 *
 * A step whose memo row `succeeded` answers its value, a step whose row is
 * `failed` fails, and any other step runs and records its value, except a
 * step run through `runIdempotent`, which records only a success over its own
 * `failing` row. A run's pass runs the engine over `createExecutorRuntime`,
 * whose `waitForEvent` answers the wake on the park's wait row and otherwise
 * records the parking step and answers `parked`, which ends the branch for
 * this pass. A delivery's pass
 * runs its steps through `createPassSteps`, which parks nothing. Every write
 * is fenced on the pass's owner token until the pass ends its row's subject.
 * Once the pass stops it starts no step. A pass a step's failure stopped still
 * holds its lease, so it renews it and accepts the writes of a step already
 * running, its memo write and the store writes made inside it
 * (`CurrentDurableStep`), and refuses every other write with `LeaseLost`,
 * which ends the body. A pass that lost its lease refuses every write and
 * aborts the signal its step bodies were handed. A step whose value's JSON is
 * larger than the pass's `maxValueBytes` fails with `StepValueTooLarge`
 * before its memo write, and the release spends that step's retries at once.
 * The caller reads `PassState` to decide the release.
 */

import { Cause, Effect, Schema } from "effect";
import { CurrentDurableStep } from "#src/backend/engine/durable";
import type {
  DurableStepRef,
  WaitAnswer,
  WaitForEventOptions,
  WaitWake,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import {
  type EngineFailure,
  engineFailure,
} from "#src/backend/engine/engine-failure";
import {
  type DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type {
  CronPassWrites,
  ParkState,
  ParkWake,
  ParkWrites,
  PassWrites,
  StepMemo,
  StoreWrites,
} from "#src/backend/services/executions/repo";
import { buildStoreWrites } from "#src/backend/services/executions/repo/fencing";
import { jsonObjectSchema, type JsonValue } from "@wfgraph/shared/types/json";
import { BARE_PARK_WAKE_KINDS } from "@wfgraph/shared/lifecycle/execution-schedule";
import { readAs } from "@wfgraph/shared/types/schema";

/**
 * A step as a pass records it: the id it is memoized under, and the node it
 * does work for (`DurableStepRef.nodeId`), or null for a step of no node.
 */
export type PassStep = { stepId: string; nodeId: string | null };

/** The `PassStep` the engine names with `step`. */
function passStepOf(step: DurableStepRef): PassStep {
  return { stepId: step.id, nodeId: step.nodeId };
}

/**
 * Why a pass stopped before its body ended on its own.
 *
 * - `step_threw`: a step body threw. The release counts a failure against
 *   that step, once every step already running has settled.
 * - `lease_lost`: a fenced write found the schedule row no longer names this
 *   pass. Another worker, a terminal write or a Migration's re-queue owns the
 *   run now, so the pass writes nothing, not even its release.
 */
export type PassStop =
  | { kind: "step_threw"; step: PassStep; error: unknown }
  | { kind: "lease_lost" };

/**
 * Where one pass stands.
 *
 * - `running`: every write is fenced on the pass's owner token.
 * - `ended`: the pass's own fenced `endRun` made the run terminal and wrote its
 *   closing timeline entry, and deleted the schedule row the fence stands on.
 *   No other pass can hold the run any more, so any store write that follows
 *   is made unfenced, and nothing more is memoized.
 * - `stopped`: see `PassStop`.
 */
export type PassPhase =
  | { kind: "running" }
  | { kind: "ended" }
  | { kind: "stopped"; stop: PassStop };

/** A step whose memo row is `failed`, as this pass answered it. */
export type SpentStep = { stepId: string; failure: EngineFailure };

export type PassState = {
  readonly phase: () => PassPhase;
  /** Records the first step that threw. A pass already stopped keeps its stop. */
  readonly stepThrew: (step: PassStep, error: unknown) => void;
  /**
   * Records a lost lease, which outranks a step that threw, and aborts
   * `signal`.
   */
  readonly leaseLost: () => void;
  /** Records that this pass wrote the run's terminal record. */
  readonly ended: () => void;
  /**
   * The signal every step body of the pass is handed. It aborts once the
   * pass loses its lease or `stopSteps` is called, never because a step threw.
   */
  readonly signal: AbortSignal;
  /** Aborts `signal`, for a pass that is being interrupted. */
  readonly stopSteps: () => void;
  /**
   * Records that a step body started running. A step started with `reported`
   * false, an idempotent one, is never the step `runningStep` answers.
   */
  readonly stepStarted: (
    step: PassStep,
    options?: { reported?: boolean | undefined }
  ) => void;
  /** Records that a step body and its memo write are done, either way. */
  readonly stepFinished: (step: PassStep) => void;
  /** Whether the step `stepId` has started and not yet finished. */
  readonly isRunning: (stepId: string) => boolean;
  /** How many step bodies have started and not yet finished. */
  readonly stepsRunning: () => number;
  /** Succeeds once no step body is running, at once when none is. */
  readonly stepsSettled: Effect.Effect<void>;
  /**
   * The step a budget cut counts a failure against: the earliest started of
   * the reported steps still running, which has run longest, since parallel
   * branches run steps side by side, and null between steps.
   */
  readonly runningStep: () => PassStep | null;
  /**
   * The step the heartbeat records as running, which an expired lease counts
   * against: the one reported step running, and null between steps or while
   * several run, since nothing then says which of them a crash was due to,
   * and the claim counts such a lease against the run.
   */
  readonly heartbeatStep: () => PassStep | null;
  /**
   * Answers a step whose memo row is `failed` with the failure the step
   * throws, and remembers that failure, so `spentStepBehind` can tell the
   * body failed because of it.
   */
  readonly spentStep: (stepId: string, message: string) => EngineFailure;
  /**
   * The step whose spent retries `error` is the failure of, or undefined when
   * `error` is no such failure. Compared by identity with what `spentStep`
   * answered.
   */
  readonly spentStepBehind: (error: unknown) => SpentStep | undefined;
};

export function createPassState(): PassState {
  let phase: PassPhase = { kind: "running" };
  const steps = new AbortController();
  const running: { step: PassStep; reported: boolean }[] = [];
  // Called once no step body is running.
  const onSettled = new Set<() => void>();
  const spent: SpentStep[] = [];
  return {
    phase: () => phase,
    stepThrew: (step, error) => {
      if (phase.kind === "stopped") return;
      phase = { kind: "stopped", stop: { kind: "step_threw", step, error } };
    },
    leaseLost: () => {
      phase = { kind: "stopped", stop: { kind: "lease_lost" } };
      steps.abort();
    },
    ended: () => {
      if (phase.kind === "running") phase = { kind: "ended" };
    },
    signal: steps.signal,
    stopSteps: () => steps.abort(),
    stepStarted: (step, options) => {
      running.push({ step, reported: options?.reported ?? true });
    },
    stepFinished: (step) => {
      const index = running.findIndex((entry) => entry.step === step);
      if (index >= 0) running.splice(index, 1);
      if (running.length > 0) return;
      for (const settled of onSettled) settled();
      onSettled.clear();
    },
    isRunning: (stepId) =>
      running.some((entry) => entry.step.stepId === stepId),
    stepsRunning: () => running.length,
    stepsSettled: Effect.suspend(() =>
      running.length === 0
        ? Effect.void
        : Effect.callback<void>((resume) => {
            const settled = () => resume(Effect.void);
            onSettled.add(settled);
            return Effect.sync(() => onSettled.delete(settled));
          })
    ),
    runningStep: () => running.find((entry) => entry.reported)?.step ?? null,
    heartbeatStep: () => {
      const reported = running.filter((entry) => entry.reported);
      return reported.length === 1 ? (reported[0]?.step ?? null) : null;
    },
    spentStep: (stepId, message) => {
      const failure = engineFailure("failure", message);
      spent.push({ stepId, failure });
      return failure;
    },
    spentStepBehind: (error) => spent.find((entry) => entry.failure === error),
  };
}

function isStopped(state: PassState): boolean {
  return state.phase().kind === "stopped";
}

/** What a pass does with one write. */
type WriteRule = "fenced" | "unfenced" | "refused";

/**
 * What a pass does with a write `admitted` says belongs to a step still
 * running, or to no such step: fenced while the pass runs, and after a step
 * threw only when `admitted`; unfenced once the pass has ended the run; and
 * refused once the pass has lost its lease.
 */
function writeRule(phase: PassPhase, admitted: () => boolean): WriteRule {
  if (phase.kind === "running") return "fenced";
  if (phase.kind === "ended") return "unfenced";
  return phase.stop.kind === "step_threw" && admitted() ? "fenced" : "refused";
}

/**
 * Runs `fenced`, recording a refusal of its fence as a lost lease, which stops
 * the pass for good.
 */
function fencedWrite<A>(
  fenced: Effect.Effect<A, DatabaseError | LeaseLost>,
  state: PassState
): Effect.Effect<A, DatabaseError | LeaseLost> {
  return fenced.pipe(
    Effect.tapError((failure) =>
      Effect.sync(() => {
        if (failure._tag === "LeaseLost") state.leaseLost();
      })
    )
  );
}

/**
 * What a stopped pass answers for a write it no longer makes and a step it no
 * longer starts.
 */
function passStopped(): LeaseLost {
  return new LeaseLost({
    message: "This pass has stopped and writes nothing more",
  });
}

/**
 * One store write of the pass, ruled on when it runs (`writeRule`): fenced,
 * stopping the pass when the fence refuses it; unfenced; or refused locally.
 * A write made inside a durable step belongs to that step
 * (`CurrentDurableStep`).
 */
function watchedStoreWrite<I, A>(
  fenced: (input: I) => Effect.Effect<A, DatabaseError | LeaseLost>,
  unfenced: (input: I) => Effect.Effect<A, DatabaseError | LeaseLost>,
  state: PassState
): (input: I) => Effect.Effect<A, DatabaseError | LeaseLost> {
  return (input) =>
    Effect.gen(function* () {
      const step = yield* CurrentDurableStep;
      const rule = writeRule(
        state.phase(),
        () => step !== null && state.isRunning(step.id)
      );
      if (rule === "refused") return yield* passStopped();
      if (rule === "unfenced") return yield* unfenced(input);
      return yield* fencedWrite(fenced(input), state);
    });
}

/**
 * One of the writes only a pass makes, which stand on the schedule row,
 * ruled on when it runs (`writeRule`) with `admitted` deciding for a pass a
 * step's failure stopped. Once the pass has ended the run it is skipped, since
 * the terminal write deleted the memo and the schedule row it would write.
 */
function watchedPassWrite<I>(
  write: (input: I) => Effect.Effect<void, DatabaseError | LeaseLost>,
  state: PassState,
  admitted: (input: I) => boolean
): (input: I) => Effect.Effect<void, DatabaseError | LeaseLost> {
  return (input) =>
    Effect.suspend(() => {
      const rule = writeRule(state.phase(), () => admitted(input));
      if (rule === "refused") return Effect.fail(passStopped());
      if (rule === "unfenced") return Effect.void;
      return fencedWrite(write(input), state);
    });
}

/**
 * The writes every pass makes, each watched by `state`. A pass a step's
 * failure stopped still renews its lease, which it holds until its release,
 * and still records the value of a step already running. The release and the
 * schedule row's deletion are passed through unwatched: a pass whose step
 * threw still writes its release, and a pass that found its subject gone
 * deletes its row before it runs anything.
 */
export function watchPassOnlyWrites(input: {
  fenced: PassWrites;
  state: PassState;
}): PassWrites {
  const { fenced, state } = input;
  return {
    renewLease: watchedPassWrite(fenced.renewLease, state, () => true),
    writeStepMemo: watchedPassWrite(fenced.writeStepMemo, state, (write) =>
      state.isRunning(write.stepId)
    ),
    releasePass: fenced.releasePass,
    dropSchedule: fenced.dropSchedule,
  };
}

/**
 * A cron pass's writes: the fire, the skip and the row's deletion, each
 * fenced and watched by `state` as a store write is, beside `passWrites`, the
 * pass's own writes already watched by the same state. A timer has no
 * terminal record, so the pass never ends its subject and every write stays
 * fenced. A deletion the fence refuses, because the workflow's deletion took
 * the row, stops the pass as a lost lease, which writes no release.
 */
export function watchCronWrites(input: {
  fenced: CronPassWrites;
  passWrites: PassWrites;
  state: PassState;
}): CronPassWrites {
  const { fenced, passWrites, state } = input;
  return {
    ...passWrites,
    dropSchedule: () =>
      watchedStoreWrite(
        fenced.dropSchedule,
        fenced.dropSchedule,
        state
      )(undefined),
    fireCronTimer: watchedStoreWrite(
      fenced.fireCronTimer,
      fenced.fireCronTimer,
      state
    ),
    skipCronSlot: watchedStoreWrite(
      fenced.skipCronSlot,
      fenced.skipCronSlot,
      state
    ),
  };
}

/**
 * One of a run pass's park writes, watched by `state` as `watchPassOnlyWrites`
 * watches the pass's own writes.
 */
export function watchParkWrites(input: {
  fenced: ParkWrites;
  state: PassState;
}): ParkWrites {
  return {
    recordParkStep: watchedPassWrite(
      input.fenced.recordParkStep,
      input.state,
      () => false
    ),
  };
}

/** A run pass's writes: the engine's store writes beside the pass's own. */
export type RunPassWrites = StoreWrites & PassWrites;

/**
 * A run pass's writes: the store writes the engine reaches, each watched by
 * `state`, beside `passWrites`, the pass's own writes already watched by the
 * same state. `unfenced` is the repository's own store writes, which the pass
 * makes once it has ended the run.
 */
export function watchStoreWrites(input: {
  fenced: StoreWrites;
  unfenced: StoreWrites;
  passWrites: PassWrites;
  state: PassState;
}): RunPassWrites {
  const { fenced, unfenced, passWrites, state } = input;
  const store = buildStoreWrites((name) =>
    watchedStoreWrite(fenced[name], unfenced[name], state)
  );
  return {
    ...store,
    endRun: (write) =>
      store.endRun(write).pipe(
        Effect.tap((answer) =>
          Effect.sync(() => {
            if (answer.kind === "ended") state.ended();
          })
        )
      ),
    ...passWrites,
  };
}

/** The wake a park's row holds, as the Wait reads it. */
function waitWakeOf(wake: ParkWake): WaitWake {
  if (wake.kind === "resume") {
    // The delivery that carried the Event is the row's own bookkeeping.
    return {
      kind: "resume",
      eventName: wake.eventName,
      payload: wake.payload,
    };
  }
  return wake;
}

/**
 * A `WaitWake` as the memo stores it under the parking step. The pass that
 * read the wake off the row wrote it, so a value that does not decode is a
 * memo row this build did not write.
 */
const readMemoizedWake = readAs(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literals(BARE_PARK_WAKE_KINDS),
    }),
    Schema.Struct({
      kind: Schema.Literal("resume"),
      eventName: Schema.NullOr(Schema.String),
      payload: jsonObjectSchema,
    }),
  ])
);

/** A copy of a step's value as the memo stores it, which is JSON. */
function memoValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * The largest serialized JSON, in bytes, one step's value may hold in the
 * memo when the host sets no other limit: 1 MiB, the size of the largest
 * request body the app accepts.
 */
export const DEFAULT_MAX_STEP_VALUE_BYTES = 1_048_576;

/**
 * A step answered a value whose JSON is larger than its pass may record.
 * Running the step again would answer the same, so the release spends the
 * step's retries at once. The message names the step and the size, never the
 * value.
 */
export class StepValueTooLarge extends Schema.TaggedError<
  StepValueTooLarge,
  { readonly brand: unique symbol }
>()("StepValueTooLarge", {
  message: Schema.String,
}) {}

/** The size of `value`'s JSON in UTF-8 bytes. */
function jsonBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * How a pass reads and marks its parks. Only a run's pass builds one, from
 * `ExecutionRepo.fenced`, so a pass over any other kind cannot park.
 */
export type ParkAccess = {
  /** Reads one park's row. */
  findPark: (
    waitStateId: string
  ) => Effect.Effect<ParkState | null, DatabaseError>;
  /** Records the parking step on a park's row, watched by the pass's state. */
  recordParkStep: ParkWrites["recordParkStep"];
};

/** What every port over a pass's step memo is built from. */
export type StepMemoInput = {
  /** Every memo row of the schedule row, loaded once at the claim, keyed by step id. */
  memo: ReadonlyMap<string, StepMemo>;
  /** Records a step's value, watched by `state`. */
  writeStepMemo: PassWrites["writeStepMemo"];
  state: PassState;
  /** Where the lease ends if renewed now, which every memo write renews to. */
  leaseExpiresAt: () => Date;
  /** The largest JSON, in bytes, one step's value may hold. */
  maxValueBytes: number;
};

/**
 * What the memo says about a step before it runs: the value it stored, a
 * refusal (its retries are spent, or the pass has stopped and starts no
 * step), or that the step runs.
 */
type MemoAnswer =
  | { kind: "value"; value: JsonValue }
  | { kind: "refused"; failure: EngineFailure | LeaseLost }
  | { kind: "run" };

/**
 * One pass's step memo: what it answers for a step, and the write that
 * records a step's value, which also updates the memo this pass reads.
 */
function stepMemoBook(input: StepMemoInput) {
  const { state } = input;
  const memo = new Map(input.memo);
  /**
   * The failure a step is refused with before it runs: its retries are spent,
   * or the pass has stopped. Undefined when the step may run.
   */
  const refusal = (stepId: string): EngineFailure | LeaseLost | undefined => {
    const stored = memo.get(stepId);
    if (stored?.status === "failed") {
      return state.spentStep(stepId, stored.error);
    }
    if (isStopped(state)) return passStopped();
    return undefined;
  };
  return {
    memo,
    refusal,
    answer: (stepId: string): MemoAnswer => {
      const stored = memo.get(stepId);
      if (stored?.status === "succeeded") {
        return { kind: "value", value: stored.value };
      }
      const failure = refusal(stepId);
      if (failure !== undefined) return { kind: "refused", failure };
      return { kind: "run" };
    },
    /**
     * Records `value` as the step's memo row. A write that fails, or a value
     * larger than `maxValueBytes` when `sized`, stops the pass as a failure of
     * that step would, unless a lost lease stopped it first. A Wait's wake is
     * recorded unsized: it carries an Event payload the inbox already took.
     */
    remember: (
      step: PassStep,
      value: JsonValue,
      options: { sized: boolean } = { sized: true }
    ) =>
      Effect.suspend(
        (): Effect.Effect<
          void,
          DatabaseError | LeaseLost | StepValueTooLarge
        > => {
          const bytes = options.sized ? jsonBytes(value) : 0;
          if (bytes > input.maxValueBytes) {
            return Effect.fail(
              new StepValueTooLarge({
                message: `Step ${step.stepId} answered ${bytes} bytes of JSON, more than the ${input.maxValueBytes} a step's value may hold`,
              })
            );
          }
          return input.writeStepMemo({
            stepId: step.stepId,
            nodeId: step.nodeId,
            value,
            leaseExpiresAt: input.leaseExpiresAt(),
          });
        }
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => state.stepThrew(step, error))
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            memo.set(step.stepId, {
              status: "succeeded",
              failures: memo.get(step.stepId)?.failures ?? 0,
              value,
            });
          })
        )
      ),
  };
}

/** What a step run through `PassSteps` may fail with besides its own error. */
export type PassStepFailure =
  | EngineFailure
  | DatabaseError
  | LeaseLost
  | StepValueTooLarge;

/**
 * The step port of a pass whose body is written as Effects: a delivery's.
 * Its steps run in the pass's own fiber, so interrupting the pass interrupts
 * the step it is running, and the step's spans open under the pass's span.
 */
export type PassSteps = {
  /**
   * Runs `step` as the durable step `id`, or answers its memoized value. The
   * attempt that ran the step gets the value it produced and every replay
   * gets the stored JSON, so the value must round-trip through JSON. A step
   * that fails stops the pass, with the step's own failure or the memo
   * write's.
   */
  readonly run: <A, E, R>(
    id: string,
    step: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | PassStepFailure, R>;
};

/**
 * The step port of a pass whose steps belong to no node, such as a
 * delivery's: every step it records names no node.
 */
export function createPassSteps(input: StepMemoInput): PassSteps {
  const { state } = input;
  const book = stepMemoBook(input);
  return {
    run: <A, E, R>(id: string, step: Effect.Effect<A, E, R>) =>
      Effect.suspend((): Effect.Effect<A, E | PassStepFailure, R> => {
        const answer = book.answer(id);
        if (answer.kind === "value") {
          // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
          return Effect.succeed(answer.value as A);
        }
        if (answer.kind === "refused") return Effect.fail(answer.failure);
        const passStep: PassStep = { stepId: id, nodeId: null };
        state.stepStarted(passStep);
        return step.pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause)) {
                state.stepThrew(passStep, Cause.squash(cause));
              }
            })
          ),
          Effect.tap((value) => book.remember(passStep, memoValue(value))),
          Effect.ensuring(Effect.sync(() => state.stepFinished(passStep)))
        );
      }),
  };
}

export type ExecutorRuntimeInput = StepMemoInput & {
  /** How the run's Waits park. */
  parks: ParkAccess;
  /** Runs one repository Effect, rejecting with its failure. */
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

/** The engine's runtime for one pass over a `run` row. */
export function createExecutorRuntime(
  input: ExecutorRuntimeInput
): WorkflowExecutionRuntime {
  const { state, runEffect, parks } = input;
  const book = stepMemoBook(input);

  /**
   * Runs one of the runtime's own reads or writes for `step`. A failure
   * stops the pass as a failure of that step would, unless a lost lease
   * stopped it first.
   */
  async function forStep<A>(step: PassStep, work: Promise<A>): Promise<A> {
    try {
      return await work;
    } catch (error) {
      state.stepThrew(step, error);
      throw error;
    }
  }

  /**
   * Runs the body of `passStep` with the pass's signal, which the heartbeat
   * records as running meanwhile unless `reported` is false, and then `after`
   * with the body's value, while the step still counts as running. A body
   * that throws stops the pass as a failure of that step, which the release
   * counts against the step; one that ends because the pass aborted its
   * signal records nothing, since the pass is ending anyway.
   */
  async function runStep<T>(
    passStep: PassStep,
    fn: (signal: AbortSignal) => Promise<T>,
    after: (value: T) => Promise<void>,
    options?: { reported?: boolean | undefined }
  ): Promise<T> {
    state.stepStarted(passStep, options);
    try {
      let value: T;
      try {
        value = await fn(state.signal);
      } catch (error) {
        if (!state.signal.aborted) state.stepThrew(passStep, error);
        throw error;
      }
      await after(value);
      return value;
    } finally {
      state.stepFinished(passStep);
    }
  }

  return {
    run: async <T>(
      step: DurableStepRef,
      fn: (signal: AbortSignal) => Promise<T>
    ): Promise<T> => {
      const answer = book.answer(step.id);
      if (answer.kind === "value") {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return answer.value as T;
      }
      if (answer.kind === "refused") throw answer.failure;

      const passStep = passStepOf(step);
      // The attempt that ran the step gets the value it returned and every
      // replay gets the stored JSON.
      return await runStep(passStep, fn, (value) =>
        runEffect(book.remember(passStep, memoValue(value)))
      );
    },

    // An idempotent step is a store write of a few milliseconds, so it is
    // never the step the heartbeat records as running, and a budget cut or a
    // lease expiry during it is counted as one between steps would be. With
    // no step recorded as running, a budget cut counts no failure: the
    // `interrupted` release keeps the run's `attempt` and re-queues the row at
    // once (`stepFailureOf`, `decideRelease`). A lease that expires with no
    // step recorded as running adds one to the run's `attempt` when the row is
    // next claimed (`claimAttempt`). A failure `fn` throws still counts
    // against the step's id. A success over a `failing` row an earlier pass
    // left marks the row `succeeded`, keeping its failure count for the node
    // log's `retries`, so the node no longer reads as retrying.
    runIdempotent: async <T>(
      step: DurableStepRef,
      fn: (signal: AbortSignal) => Promise<T>
    ): Promise<T> => {
      const failure = book.refusal(step.id);
      if (failure !== undefined) throw failure;
      return await runStep(
        passStepOf(step),
        fn,
        async () => {
          if (book.memo.get(step.id)?.status === "failing") {
            await runEffect(book.remember(passStepOf(step), null));
          }
        },
        { reported: false }
      );
    },

    waitForEvent: async (
      step: DurableStepRef,
      options: WaitForEventOptions
    ): Promise<WaitAnswer> => {
      const stored = book.memo.get(step.id);
      // A park step whose retries are spent fails the Wait as a step would.
      // It never reads as a wake.
      if (stored?.status === "failed") {
        throw state.spentStep(step.id, stored.error);
      }
      if (stored?.status === "succeeded") {
        const wake = readMemoizedWake(stored.value);
        if (wake === undefined) {
          throw engineFailure(
            "failure",
            `Step ${step.id} holds a memoized value that is not a wake`
          );
        }
        return { kind: "woke", wake };
      }
      // A stopped pass halts the branch where it stands, writing nothing.
      if (isStopped(state)) {
        return { kind: "parked" };
      }
      const { waitStateId } = options;
      const passStep = passStepOf(step);
      const park = await forStep(
        passStep,
        runEffect(parks.findPark(waitStateId))
      );
      if (!park) {
        const gone = new Error(
          `Step ${step.id} parks on a wait row that is gone`
        );
        state.stepThrew(passStep, gone);
        throw gone;
      }

      // A wake on the row is this park's: a re-park clears the wake it
      // supersedes. The wake is memoized under the parking step, because a
      // later attempt of the same Wait re-parks the row and a replay of this
      // attempt still has to read what woke it.
      if (park.wake) {
        const wake = waitWakeOf(park.wake);
        await runEffect(book.remember(passStep, wake, { sized: false }));
        return { kind: "woke", wake };
      }
      if (park.parkStepId !== step.id) {
        await forStep(
          passStep,
          runEffect(parks.recordParkStep({ waitStateId, parkStepId: step.id }))
        );
      }
      return { kind: "parked" };
    },
  };
}
