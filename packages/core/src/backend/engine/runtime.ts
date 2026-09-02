/**
 * Durability port for the workflow engine.
 *
 * A durable runtime (Inngest in production) re-runs the whole workflow function
 * body every time a run resumes - after a sleep, after a hook wait, after a
 * retry. Only work handed to `step` is remembered; everything else happens
 * again on each replay. This interface is the engine's entire view of that
 * machinery, so the engine module never imports Inngest.
 *
 * Sibling port: `WorkflowStore` in ./store covers persistence. Nothing here may
 * know about database rows, and nothing there may know about replay.
 */

import type { BranchHandoff } from "#src/backend/engine/branch";

export type WaitForEventOptions = {
  event: string;
  timeoutMs?: number | undefined;
  ifExpression?: string | undefined;
};

/**
 * How the engine names one durable step to the runtime.
 *
 * `id` is the memoization key and nothing else: change it and a run in flight
 * repeats the work it already did. `name` is what a durable runtime's UI prints
 * for the step, carries no meaning to the runtime, and may be reworded at any
 * time. The two are split because an id has to survive a rename of the node it
 * belongs to, while the label a person reads should follow that rename.
 */
export type DurableStepRef = { id: string; name?: string };

export type WorkflowExecutionRuntime = {
  sleep: (step: DurableStepRef, durationMs: number) => Promise<void>;
  waitForEvent: (
    step: DurableStepRef,
    options: WaitForEventOptions
  ) => Promise<unknown>;
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
   */
  run: <T>(step: DurableStepRef, fn: () => Promise<T>) => Promise<T>;
  /**
   * Hands the branch below one node to a durable run of its own (ADR-0011), and
   * parks the caller until that run ends.
   *
   * `releasedNodeIds` are the nodes this run has already let its downstream
   * follow, which is what tells the branch it may enter its entry node at all.
   * A runtime that starts no durable runs leaves this out, and the engine then
   * enters the Wait where it stands.
   */
  startBranch?:
    | ((
        step: DurableStepRef,
        input: { entryNodeId: string; releasedNodeIds: readonly string[] }
      ) => Promise<BranchHandoff>)
    | undefined;
  /**
   * Zero-indexed retry counter for the current attempt, which holds across every
   * replay within that attempt and rises when the runtime retries the body. A
   * step id carrying it is memoized per attempt, so a later attempt may correct
   * what an earlier one wrote.
   */
  attempt: number;
  runId?: string | undefined;
};

export type InMemoryRuntimeOptions = {
  /**
   * Step memo. Driving the engine twice against the same map models a durable
   * replay: the second pass reads stored results instead of repeating the work.
   * Left out, each runtime gets a fresh map and memoizes within one run only.
   */
  memo?: Map<string, unknown> | undefined;
  /** What `waitForEvent` resolves to. `null` models a timeout. */
  resumeEvent?: unknown;
  /** Resolve sleeps immediately instead of sitting through a real timer. */
  skipSleep?: boolean | undefined;
  /** The attempt this runtime reports. See `WorkflowExecutionRuntime.attempt`. */
  attempt?: number | undefined;
};

export type InMemoryWorkflowRuntime = WorkflowExecutionRuntime & {
  readonly memo: Map<string, unknown>;
  readonly sleeps: Array<{ stepId: string; durationMs: number }>;
  readonly waits: Array<{ stepId: string; options: WaitForEventOptions }>;
};

/**
 * Runtime adapter for everything that is not Inngest: the engine's own default
 * and the one tests drive.
 *
 * Stored values round-trip through JSON exactly like a durable runtime persists
 * them, so a step returning something unserializable behaves here the way it
 * would in production rather than quietly working in tests only.
 *
 * The attempt that ran a step gets the value the step returned, and every replay
 * after it gets the JSON that was stored. That asymmetry is Inngest's, and copying
 * it is what makes a value whose type differs between the two visible here: a live
 * `Date` read back as a string on the replay alone is the failure mode the engine
 * is least able to survive, and a runtime that round-tripped eagerly would hand
 * both passes the string and hide it.
 */
export function createInMemoryWorkflowRuntime(
  options: InMemoryRuntimeOptions = {}
): InMemoryWorkflowRuntime {
  const { resumeEvent = null, skipSleep = false, attempt = 0 } = options;
  const memo = options.memo ?? new Map<string, unknown>();
  const sleeps: Array<{ stepId: string; durationMs: number }> = [];
  const waits: Array<{ stepId: string; options: WaitForEventOptions }> = [];

  return {
    memo,
    sleeps,
    waits,
    attempt,

    sleep: async (step, durationMs) => {
      sleeps.push({ stepId: step.id, durationMs });
      if (skipSleep || durationMs <= 0) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, durationMs);
      });
    },

    waitForEvent: (step, waitOptions) => {
      waits.push({ stepId: step.id, options: waitOptions });
      return Promise.resolve(resumeEvent);
    },

    // The display name is dropped rather than recorded: it is a label for a
    // durable runtime's UI, and a test asserting on one would be asserting on
    // wording no behaviour reads.
    run: async <T>(step: DurableStepRef, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(step.id)) {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return memo.get(step.id) as T;
      }

      const value = await fn();

      memo.set(step.id, JSON.parse(JSON.stringify(value ?? null)));

      return value;
    },
  };
}
