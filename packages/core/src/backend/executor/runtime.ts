/**
 * The ports a database executor pass runs its body through, over the step
 * memo it loaded when it claimed its schedule row.
 *
 * A step whose memo row `succeeded` answers its value, a step whose row is
 * `failed` fails, and any other step runs and records its value. A run's pass
 * runs the engine over `createExecutorRuntime`, whose `waitForEvent` answers
 * the wake on the park's wait row and otherwise records the parking step and
 * answers `parked`, which ends the branch for this pass. A delivery's pass
 * runs its steps through `createPassSteps`, which parks nothing. Every write
 * is fenced on the pass's owner token until the pass ends its row's subject.
 * Once the pass stops, because a step threw or the lease was lost, it starts
 * no step and writes nothing more: each attempt fails with `LeaseLost`, which
 * ends the body. The caller reads `PassState` to decide the release.
 */

import { Cause, Effect, Schema } from "effect";
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
  ParkState,
  ParkWake,
  ParkWrites,
  PassWrites,
  StepMemo,
  StoreWrites,
} from "#src/backend/services/executions/repo";
import { buildStoreWrites } from "#src/backend/services/executions/repo/fencing";
import { jsonObjectSchema, type JsonValue } from "@wfgraph/shared/types/json";
import { readAs } from "@wfgraph/shared/types/schema";

/**
 * Why a pass stopped before its body ended on its own.
 *
 * - `step_threw`: a step body threw. The release counts a failure against
 *   that step.
 * - `lease_lost`: a fenced write found the schedule row no longer names this
 *   pass. Another worker, a terminal write or a Migration's re-queue owns the
 *   run now, so the pass writes nothing, not even its release.
 */
export type PassStop =
  | { kind: "step_threw"; stepId: string; error: unknown }
  | { kind: "lease_lost" };

/**
 * Where one pass stands.
 *
 * - `running`: every write is fenced on the pass's owner token.
 * - `ended`: the pass's own fenced write made the run terminal, which deleted
 *   the schedule row the fence stands on. No other pass can hold the run any
 *   more, so the store writes that follow, such as the run's closing timeline
 *   entry, are made unfenced, and nothing more is memoized.
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
  readonly stepThrew: (stepId: string, error: unknown) => void;
  /** Records a lost lease, which outranks a step that threw. */
  readonly leaseLost: () => void;
  /** Records that this pass wrote the run's terminal record. */
  readonly ended: () => void;
  /** Records that a step body started running. */
  readonly stepStarted: (stepId: string) => void;
  /** Records that a step body and its memo write are done, either way. */
  readonly stepFinished: (stepId: string) => void;
  /**
   * The step the heartbeat records as running: the earliest started of the
   * steps still running, since parallel branches run steps side by side, and
   * null between steps.
   */
  readonly runningStep: () => string | null;
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
  const running: string[] = [];
  const spent: SpentStep[] = [];
  return {
    phase: () => phase,
    stepThrew: (stepId, error) => {
      if (phase.kind === "stopped") return;
      phase = { kind: "stopped", stop: { kind: "step_threw", stepId, error } };
    },
    leaseLost: () => {
      phase = { kind: "stopped", stop: { kind: "lease_lost" } };
    },
    ended: () => {
      if (phase.kind === "running") phase = { kind: "ended" };
    },
    stepStarted: (stepId) => {
      running.push(stepId);
    },
    stepFinished: (stepId) => {
      const index = running.indexOf(stepId);
      if (index >= 0) running.splice(index, 1);
    },
    runningStep: () => running[0] ?? null,
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
 * One store write of the pass: fenced while the pass runs, stopping the pass
 * when the fence refuses it; unfenced once the pass has ended the run; and
 * refused locally once the pass has stopped.
 */
function watchedStoreWrite<I, A>(
  fenced: (input: I) => Effect.Effect<A, DatabaseError | LeaseLost>,
  unfenced: (input: I) => Effect.Effect<A, DatabaseError | LeaseLost>,
  state: PassState
): (input: I) => Effect.Effect<A, DatabaseError | LeaseLost> {
  return (input) => {
    const { kind } = state.phase();
    if (kind === "stopped") return Effect.fail(passStopped());
    if (kind === "ended") return unfenced(input);
    return fenced(input).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          if (failure._tag === "LeaseLost") state.leaseLost();
        })
      )
    );
  };
}

/**
 * One of the writes only a pass makes, which stand on the schedule row: fenced
 * while the pass runs, and skipped once the pass has ended the run, since the
 * terminal write deleted the memo and the schedule row they would write.
 */
function watchedPassWrite<I>(
  write: (input: I) => Effect.Effect<void, DatabaseError | LeaseLost>,
  state: PassState
): (input: I) => Effect.Effect<void, DatabaseError | LeaseLost> {
  return watchedStoreWrite(write, () => Effect.void, state);
}

/**
 * The writes every pass makes, each watched by `state`. The release and the
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
    renewLease: watchedPassWrite(fenced.renewLease, state),
    writeStepMemo: watchedPassWrite(fenced.writeStepMemo, state),
    releasePass: fenced.releasePass,
    dropSchedule: fenced.dropSchedule,
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
    recordParkStep: watchedPassWrite(input.fenced.recordParkStep, input.state),
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
    finishRun: (write) =>
      store.finishRun(write).pipe(
        Effect.tap((written) =>
          Effect.sync(() => {
            if (written?.didWrite === true) state.ended();
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
      kind: Schema.Literals(["timeout", "migrate", "cancel", "exit"]),
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
  return {
    memo,
    answer: (stepId: string): MemoAnswer => {
      const stored = memo.get(stepId);
      if (stored?.status === "succeeded") {
        return { kind: "value", value: stored.value };
      }
      if (stored?.status === "failed") {
        return {
          kind: "refused",
          failure: state.spentStep(stepId, stored.error),
        };
      }
      if (isStopped(state)) return { kind: "refused", failure: passStopped() };
      return { kind: "run" };
    },
    /**
     * Records `value` as the step's memo row. A write that fails stops the
     * pass as a failure of that step would, unless a lost lease stopped it
     * first.
     */
    remember: (stepId: string, value: JsonValue) =>
      input
        .writeStepMemo({
          stepId,
          value,
          leaseExpiresAt: input.leaseExpiresAt(),
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => state.stepThrew(stepId, error))
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              memo.set(stepId, {
                status: "succeeded",
                failures: memo.get(stepId)?.failures ?? 0,
                value,
              });
            })
          )
        ),
  };
}

/** What a step run through `PassSteps` may fail with besides its own error. */
export type PassStepFailure = EngineFailure | DatabaseError | LeaseLost;

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
        state.stepStarted(id);
        return step.pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause)) {
                state.stepThrew(id, Cause.squash(cause));
              }
            })
          ),
          Effect.tap((value) => book.remember(id, memoValue(value))),
          Effect.ensuring(Effect.sync(() => state.stepFinished(id)))
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
   * Runs one of the runtime's own reads or writes for `stepId`. A failure
   * stops the pass as a failure of that step would, unless a lost lease
   * stopped it first.
   */
  async function forStep<A>(stepId: string, work: Promise<A>): Promise<A> {
    try {
      return await work;
    } catch (error) {
      state.stepThrew(stepId, error);
      throw error;
    }
  }

  return {
    run: async <T>(step: DurableStepRef, fn: () => Promise<T>): Promise<T> => {
      const answer = book.answer(step.id);
      if (answer.kind === "value") {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return answer.value as T;
      }
      if (answer.kind === "refused") throw answer.failure;

      state.stepStarted(step.id);
      try {
        let value: T;
        try {
          value = await fn();
        } catch (error) {
          state.stepThrew(step.id, error);
          throw error;
        }
        // The attempt that ran the step gets the value it returned and every
        // replay gets the stored JSON.
        await runEffect(book.remember(step.id, memoValue(value)));
        return value;
      } finally {
        state.stepFinished(step.id);
      }
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
      const park = await forStep(
        step.id,
        runEffect(parks.findPark(waitStateId))
      );
      if (!park) {
        const gone = new Error(
          `Step ${step.id} parks on a wait row that is gone`
        );
        state.stepThrew(step.id, gone);
        throw gone;
      }

      // A wake on the row is this park's: a re-park clears the wake it
      // supersedes. The wake is memoized under the parking step, because a
      // later attempt of the same Wait re-parks the row and a replay of this
      // attempt still has to read what woke it.
      if (park.wake) {
        const wake = waitWakeOf(park.wake);
        await runEffect(book.remember(step.id, wake));
        return { kind: "woke", wake };
      }
      if (park.parkStepId !== step.id) {
        await forStep(
          step.id,
          runEffect(parks.recordParkStep({ waitStateId, parkStepId: step.id }))
        );
      }
      return { kind: "parked" };
    },
  };
}
