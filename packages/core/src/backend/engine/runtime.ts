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

export type WaitForEventOptions = {
  event: string;
  timeoutMs?: number;
  ifExpression?: string;
};

export type WorkflowExecutionRuntime = {
  sleep: (stepId: string, durationMs: number) => Promise<void>;
  waitForEvent: (
    stepId: string,
    options: WaitForEventOptions
  ) => Promise<unknown>;
  /**
   * Runs one unit of work as a durable, memoized step.
   *
   * The runtime stores the return value under `stepId` and hands it back
   * instead of calling `fn` again on a replay. Anything with a side effect
   * (sending an email, writing a log row) must therefore be wrapped, or it
   * happens once per replay.
   *
   * INVARIANT: the returned value round-trips through JSON on its way into and
   * out of the runtime's storage. A `Date`, `Map`, `Set`, `Buffer`, function,
   * or `bigint` inside it either changes shape or throws when the run resumes.
   * Return plain objects, arrays, strings, numbers, booleans, and null - and
   * carry timestamps as ISO strings.
   */
  run: <T>(stepId: string, fn: () => Promise<T>) => Promise<T>;
  runId?: string;
};

export type InMemoryRuntimeOptions = {
  /**
   * Step memo. Driving the engine twice against the same map models a durable
   * replay: the second pass reads stored results instead of repeating the work.
   * Left out, each runtime gets a fresh map and memoizes within one run only.
   */
  memo?: Map<string, unknown>;
  /** What `waitForEvent` resolves to. `null` models a timeout. */
  resumeEvent?: unknown;
  /** Resolve sleeps immediately instead of sitting through a real timer. */
  skipSleep?: boolean;
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
  const { resumeEvent = null, skipSleep = false } = options;
  const memo = options.memo ?? new Map<string, unknown>();
  const sleeps: Array<{ stepId: string; durationMs: number }> = [];
  const waits: Array<{ stepId: string; options: WaitForEventOptions }> = [];

  return {
    memo,
    sleeps,
    waits,

    sleep: async (stepId, durationMs) => {
      sleeps.push({ stepId, durationMs });
      if (skipSleep || durationMs <= 0) {
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, durationMs);
      });
    },

    waitForEvent: (stepId, waitOptions) => {
      waits.push({ stepId, options: waitOptions });
      return Promise.resolve(resumeEvent);
    },

    run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(stepId)) {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return memo.get(stepId) as T;
      }

      const value = await fn();

      memo.set(stepId, JSON.parse(JSON.stringify(value ?? null)));

      return value;
    },
  };
}
