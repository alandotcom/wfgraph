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

import { getAppLogger } from "#src/backend/lib/logger";

const runtimeLogger = getAppLogger("workflow", "runtime");

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
  step: <T>(stepId: string, fn: () => Promise<T>) => Promise<T>;
  runId?: string;
};

/** Types that either throw or silently change shape on a JSON round-trip. */
function describeLossyType(value: object): string | undefined {
  if (value instanceof Date) {
    return "Date";
  }
  if (value instanceof Map) {
    return "Map";
  }
  if (value instanceof Set) {
    return "Set";
  }
  if (ArrayBuffer.isView(value)) {
    return "binary data";
  }

  return undefined;
}

/**
 * Names the first value inside `value` that would not survive the JSON
 * round-trip a durable runtime performs, or undefined when it is clean.
 */
function findNonJsonSafeValue(
  value: unknown,
  path = "<root>",
  seen = new Set<object>()
): string | undefined {
  if (typeof value === "bigint" || typeof value === "function") {
    return `${path} (${typeof value})`;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const lossyType = describeLossyType(value);
  if (lossyType) {
    return `${path} (${lossyType})`;
  }

  if (seen.has(value)) {
    return `${path} (circular reference)`;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findNonJsonSafeValue(item, `${path}[${index}]`, seen);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const found = findNonJsonSafeValue(item, `${path}.${key}`, seen);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/** Production builds skip the walk entirely; it exists to catch mistakes early. */
const shouldCheckStepResults = process.env.NODE_ENV !== "production";

function warnIfStepResultIsNotJsonSafe(stepId: string, value: unknown) {
  if (!shouldCheckStepResults) {
    return;
  }

  const offender = findNonJsonSafeValue(value);
  if (offender) {
    runtimeLogger.warn(
      `Step "${stepId}" returned a value that will not survive a durable replay: ${offender}`,
      { stepId, offender }
    );
  }
}

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

    step: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(stepId)) {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
        return memo.get(stepId) as T;
      }

      const value = await fn();
      warnIfStepResultIsNotJsonSafe(stepId, value);

      memo.set(stepId, JSON.parse(JSON.stringify(value ?? null)));

      return value;
    },
  };
}
