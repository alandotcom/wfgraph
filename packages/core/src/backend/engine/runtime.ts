/**
 * Durability port for the workflow engine.
 *
 * A durable runtime (the database executor in `executor/` in production)
 * re-runs the whole workflow body on every pass of a run: after a park
 * resolves, after a retry. Only work handed to `step` is remembered; everything
 * else happens again on each replay. This interface is the engine's entire
 * view of that machinery, so the engine never imports the executor.
 *
 * Sibling port: `WorkflowStore` in ./store covers persistence. Nothing here may
 * know about database rows, and nothing there may know about replay.
 */

import type { JsonObject } from "@wfgraph/shared/types/json";

export type WaitForEventOptions = {
  /**
   * The wait row this park is written on. The database executor reads the
   * park's wake from that row and records the parking step on it, and the
   * row's `wait_until` is the park's deadline.
   */
  waitStateId: string;
};

/**
 * How the engine names one durable step to the runtime.
 *
 * `id` is the memoization key and nothing else: change it and a run in flight
 * repeats the work it already did. `name` is a label for a person reading the
 * engine's code or a test. No runtime reads it, so it may be reworded at any
 * time. The two are split because an id has to survive a rename of the node it
 * belongs to, while the label a person reads should follow that rename.
 *
 * `nodeId` is the node the step does work for, and null for a step of no
 * node, such as the run's terminal record. The database executor stores it
 * beside the step's memo row, which is how the Runs view names the node of a
 * retrying step: step ids take several shapes, so no reader parses one.
 *
 * `enclosing` marks a step whose work starts other steps of the same node, as
 * a host action's handler step does. A runtime that charges an interrupted
 * pass to the step that was running charges the enclosed step while one
 * runs, and the enclosing step between them.
 */
export type DurableStepRef = {
  id: string;
  name?: string;
  nodeId: string | null;
  enclosing?: boolean | undefined;
};

/**
 * Why a park ended.
 *
 * `timeout` is the park running out of the time it was given. `resume` is an
 * Event or a manual resume. `cancel` is a Cancel Event claiming the run, and
 * `exit` is another branch of the run claiming an Entity Eligibility Exit.
 * `migrate` is a Migration telling the Wait to prepare itself again.
 *
 * A `cancel` wake never reaches a Wait on the Canceled side: the cancellation
 * wakes the Waits parked when the claim landed, and a Canceled-side Wait parks
 * after that.
 */
export type WaitWake =
  | { kind: "timeout" }
  | { kind: "migrate" }
  | { kind: "cancel" }
  | { kind: "exit" }
  | { kind: "resume"; eventName: string | null; payload: JsonObject };

/**
 * What `waitForEvent` answers: the wake that ended the park, or that the park
 * has not ended yet.
 *
 * A runtime that answers `parked` runs the body again once the park resolves.
 * The engine halts the Wait's branch with the node unfinished, runs every other
 * branch as far as it can, and returns a parked result with no terminal record.
 */
export type WaitAnswer = { kind: "woke"; wake: WaitWake } | { kind: "parked" };

export type WorkflowExecutionRuntime = {
  /**
   * Parks the Wait on the wait row `options` names and answers why the park
   * ended, or that it has not ended yet.
   */
  waitForEvent: (
    step: DurableStepRef,
    options: WaitForEventOptions
  ) => Promise<WaitAnswer>;
  /**
   * Runs one unit of work as a durable, memoized step.
   *
   * The runtime stores the return value under `step.id` and hands it back
   * instead of calling `fn` again on a replay. Anything with a side effect
   * (sending an email, writing a log row) must therefore be wrapped, or it
   * happens once per replay.
   *
   * INVARIANT: the returned value round-trips through JSON on its way into and
   * out of the runtime's storage. A `Date`, `Map`, `Set`, `Buffer`, function,
   * or `bigint` inside it either changes shape or throws when the run resumes.
   * Return plain objects, arrays, strings, numbers, booleans, and null - and
   * carry timestamps as ISO strings.
   *
   * Stated rather than typed: `JsonSafe` guards the two signatures an author
   * writes against, and a port that adapters implement and forward through
   * cannot carry it, because comparing two generic signatures re-applies the
   * check to a value that already passed it.
   *
   * `fn` is handed the signal the runtime aborts when it stops a step already
   * running, such as the database executor on an interrupted pass. A step that
   * passes it on ends early; one that ignores it runs on detached.
   */
  run: <T>(
    step: DurableStepRef,
    fn: (signal: AbortSignal) => Promise<T>
  ) => Promise<T>;
  /**
   * Runs `fn` on every pass, which is safe only because `fn` is idempotent. It
   * stores no value. A failure counts against `step.id` and stops the pass
   * exactly as a failure inside `run` does, and a step whose retries are spent
   * is refused before `fn` is called. A success after counted failures is
   * recorded, so the step no longer reads as retrying. The step is never the
   * one the runtime reports as running, since `fn` is a short store write.
   * `fn` is handed the same signal as `run`'s.
   */
  runIdempotent: <T>(
    step: DurableStepRef,
    fn: (signal: AbortSignal) => Promise<T>
  ) => Promise<T>;
};

export type InMemoryRuntimeOptions = {
  /**
   * Step memo. Driving the engine twice against the same map models a durable
   * replay: the second pass reads stored results instead of repeating the work.
   * Left out, each runtime gets a fresh map and memoizes within one run only.
   */
  memo?: Map<string, unknown> | undefined;
  /** What `waitForEvent` answers for every park. Left out, every park times out. */
  waitAnswer?: WaitAnswer | undefined;
};

export type InMemoryWorkflowRuntime = WorkflowExecutionRuntime & {
  readonly memo: Map<string, unknown>;
  readonly waits: Array<{ stepId: string; options: WaitForEventOptions }>;
};

/**
 * A runtime with no storage behind it: the engine's own default and the one
 * tests drive.
 *
 * Stored values round-trip through JSON exactly like a durable runtime persists
 * them, so a step returning something unserializable behaves here the way it
 * would in production rather than quietly working in tests only.
 *
 * The attempt that ran a step gets the value the step returned, and every replay
 * after it gets the JSON that was stored. That asymmetry is the database
 * executor's, and copying it is what makes a value whose type differs between
 * the two visible here: a live `Date` read back as a string on the replay alone
 * is the failure mode the engine is least able to survive, and a runtime that
 * round-tripped eagerly would hand both passes the string and hide it.
 */
export function createInMemoryWorkflowRuntime(
  options: InMemoryRuntimeOptions = {}
): InMemoryWorkflowRuntime {
  const { waitAnswer = { kind: "woke", wake: { kind: "timeout" } } } = options;
  const memo = options.memo ?? new Map<string, unknown>();
  const waits: Array<{ stepId: string; options: WaitForEventOptions }> = [];
  // Nothing stops a step here, so the signal every step is handed never aborts.
  const { signal } = new AbortController();

  return {
    memo,
    waits,

    waitForEvent: (step, waitOptions) => {
      waits.push({ stepId: step.id, options: waitOptions });
      return Promise.resolve(waitAnswer);
    },

    // The display name is dropped rather than recorded: no runtime reads it,
    // and a test asserting on one would be asserting on wording no behaviour
    // reads.
    run: async <T>(
      step: DurableStepRef,
      fn: (signal: AbortSignal) => Promise<T>
    ): Promise<T> => {
      if (memo.has(step.id)) {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return memo.get(step.id) as T;
      }

      const value = await fn(signal);

      memo.set(step.id, JSON.parse(JSON.stringify(value ?? null)));

      return value;
    },

    // Nothing here counts failures, so an idempotent step only runs.
    runIdempotent: <T>(
      _step: DurableStepRef,
      fn: (signal: AbortSignal) => Promise<T>
    ) => fn(signal),
  };
}
