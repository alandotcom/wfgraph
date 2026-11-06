/**
 * The database executor's `WorkflowExecutionRuntime` for one pass of one run.
 *
 * A pass replays the body against the step memo it loaded when it claimed the
 * run. `run` answers a step whose memo row `succeeded` with its value, fails a
 * step whose row is `failed`, and otherwise runs the step and records its
 * value; `waitForEvent` answers the wake on the park's wait row and otherwise
 * records the parking step and answers `parked`, which ends the branch for
 * this pass. Every write is fenced on the pass's owner token until the pass
 * writes the run's terminal record. Once the pass stops, because a step threw
 * or the lease was lost, it starts no step and writes nothing more: each
 * attempt fails with `LeaseLost`, which ends the body. The caller reads
 * `PassState` to decide the release.
 */

import { Effect, Schema } from "effect";
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
  FencedExecutionWrites,
  ParkState,
  ParkWake,
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
 * The pass's writes, each watched by `state`. `unfenced` is the repository's
 * own store writes, which the pass makes once it has ended the run. The
 * release and the schedule row's deletion are passed through unwatched: a pass
 * whose step threw still writes its release, and a pass that found its run no
 * longer in flight deletes its row before it runs anything.
 */
export function watchPassWrites(input: {
  fenced: FencedExecutionWrites;
  unfenced: StoreWrites;
  state: PassState;
}): FencedExecutionWrites {
  const { fenced, unfenced, state } = input;
  const fencedStore: StoreWrites = fenced;
  const store = buildStoreWrites((name) =>
    watchedStoreWrite(fencedStore[name], unfenced[name], state)
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
    renewLease: watchedPassWrite(fenced.renewLease, state),
    writeStepMemo: watchedPassWrite(fenced.writeStepMemo, state),
    recordParkStep: watchedPassWrite(fenced.recordParkStep, state),
    releasePass: fenced.releasePass,
    dropSchedule: fenced.dropSchedule,
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

export type ExecutorRuntimeInput = {
  executionId: string;
  /** The run's own failure count at the claim. */
  attempt: number;
  /** Every memo row of the run, loaded once at the claim, keyed by step id. */
  memo: ReadonlyMap<string, StepMemo>;
  /** The pass's writes, watched by `state`. */
  writes: FencedExecutionWrites;
  /** Reads one park's row. */
  findPark: (
    waitStateId: string
  ) => Effect.Effect<ParkState | null, DatabaseError>;
  state: PassState;
  /** Where the lease ends if renewed now, which every memo write renews to. */
  leaseExpiresAt: () => Date;
  /** Runs one repository Effect, rejecting with its failure. */
  runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

export function createExecutorRuntime(
  input: ExecutorRuntimeInput
): WorkflowExecutionRuntime {
  const { attempt, state, writes, runEffect } = input;
  const memo = new Map(input.memo);

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

  async function remember(stepId: string, value: JsonValue): Promise<void> {
    await runEffect(
      writes.writeStepMemo({
        stepId,
        value,
        leaseExpiresAt: input.leaseExpiresAt(),
      })
    );
    memo.set(stepId, {
      status: "succeeded",
      failures: memo.get(stepId)?.failures ?? 0,
      value,
    });
  }

  return {
    attempt,
    // A wait row is found by execution, run and node, so the run id has to be
    // the same on every pass of the Execution.
    runId: input.executionId,

    run: async <T>(step: DurableStepRef, fn: () => Promise<T>): Promise<T> => {
      const stored = memo.get(step.id);
      if (stored?.status === "succeeded") {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return stored.value as T;
      }
      if (stored?.status === "failed") {
        throw state.spentStep(step.id, stored.error);
      }
      if (isStopped(state)) {
        throw passStopped();
      }

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
        await forStep(step.id, remember(step.id, memoValue(value)));
        return value;
      } finally {
        state.stepFinished(step.id);
      }
    },

    waitForEvent: async (
      step: DurableStepRef,
      options: WaitForEventOptions
    ): Promise<WaitAnswer> => {
      const stored = memo.get(step.id);
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
        runEffect(input.findPark(waitStateId))
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
        await forStep(step.id, remember(step.id, wake));
        return { kind: "woke", wake };
      }
      if (park.parkStepId !== step.id) {
        await forStep(
          step.id,
          runEffect(writes.recordParkStep({ waitStateId, parkStepId: step.id }))
        );
      }
      return { kind: "parked" };
    },
  };
}
