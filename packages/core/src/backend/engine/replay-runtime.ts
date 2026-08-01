/**
 * A `WorkflowExecutionRuntime` that replays the way a durable one does, for a
 * test that has to see what suspension costs the rest of the graph.
 *
 * `createInMemoryWorkflowRuntime` resolves everything where it stands, so a
 * branch never suspends and every ordering question it could answer is the
 * answer the engine's own `Promise.all` gives. This driver instead abandons the
 * body at each step boundary and calls it again from the top, on a virtual
 * clock, which is what makes "the run parked here, and that branch had to wait
 * for it" a fact a test can assert on.
 *
 * The executor policy below is Inngest's, read off a dev-server trace rather
 * than off its documentation. `docs/adr/0004` covers why Inngest is the
 * substrate; the policy itself is stated at `advanceToLastPause`.
 */

import type {
  WaitForEventOptions,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";

/** One memoized step the driver ran, and where in the run it ran. */
export type ReplayExecution = {
  /** Which invocation of the body discovered it, counted from zero. */
  invocation: number;
  /** The virtual clock when it ran, in milliseconds from the start of the run. */
  at: number;
  stepId: string;
};

export type ReplayRunOptions = {
  /**
   * What an event wait resolves to, keyed by its step id. A wait with no answer
   * here runs to its timeout, which the engine reads as `null`.
   */
  events?: Record<string, unknown>;
  /** Invocation ceiling, which turns a non-converging graph into a failure. */
  maxInvocations?: number;
};

export type ReplayRun<T> = {
  value: T;
  /** Every step the driver ran, in order. */
  executed: ReplayExecution[];
  /** How many times the body was called from the top. */
  invocations: number;
  /** The virtual clock when the body finally returned, in milliseconds. */
  elapsedMs: number;
};

/** An event wait the engine left unbounded still has to end somewhere. */
const FALLBACK_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_INVOCATIONS = 200;

/**
 * How many empty macrotask turns mark the body as done making progress.
 *
 * A pass ends when every branch is blocked on a step the driver has yet to run,
 * and blocked is the absence of activity, so it is measured rather than
 * signalled. Five turns is slack for the in-memory awaits a store adapter makes
 * between two step calls.
 */
const QUIET_TURNS = 5;

/** A step the current pass has to discover rather than answer. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Resolved by the next invocation reading the memo, never by this one.
  });
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** What one invocation of the body left behind. */
type Pass = {
  /** Steps this pass asked for, in the order it asked. */
  readonly runs: Map<string, () => Promise<unknown>>;
  /** Sleeps and event waits this pass is blocked on. */
  readonly pauses: Set<string>;
  /** Event-wait options, kept so a timeout can be told from an answer. */
  readonly waits: Map<string, WaitForEventOptions>;
};

/**
 * Runs `body` to completion across as many invocations as it takes, and answers
 * with what it returned and everything the driver had to run on its behalf.
 *
 * `body` is called once per invocation and must build its own state each time,
 * which is what the engine does: `executeWorkflow` constructs a fresh
 * `Traversal` per call and recovers the rest from the memo.
 */
export async function driveWithReplay<T>(
  body: (runtime: WorkflowExecutionRuntime) => Promise<T>,
  options: ReplayRunOptions = {}
): Promise<ReplayRun<T>> {
  const { events = {}, maxInvocations = DEFAULT_MAX_INVOCATIONS } = options;

  const memo = new Map<string, unknown>();
  const finishedSleeps = new Set<string>();
  const finishedWaits = new Map<string, unknown>();
  /** When each pause fires, fixed the first time the body reaches it. */
  const wakeAt = new Map<string, number>();
  const executed: ReplayExecution[] = [];

  let now = 0;
  let invocation = 0;

  while (invocation < maxInvocations) {
    const pass: Pass = { runs: new Map(), pauses: new Set(), waits: new Map() };
    let discoveries = 0;

    const noteFirstReach = (stepId: string, durationMs: number) => {
      if (!wakeAt.has(stepId)) {
        wakeAt.set(stepId, now + Math.max(durationMs, 0));
      }
      pass.pauses.add(stepId);
      discoveries += 1;
    };

    const runtime: WorkflowExecutionRuntime = {
      attempt: 0,
      runId: "replay-run",

      run: <R>(stepId: string, fn: () => Promise<R>): Promise<R> => {
        if (memo.has(stepId)) {
          // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
          return Promise.resolve(memo.get(stepId) as R);
        }
        if (!pass.runs.has(stepId)) {
          pass.runs.set(stepId, fn);
          discoveries += 1;
        }
        return pending<R>();
      },

      sleep: (stepId, durationMs) => {
        if (finishedSleeps.has(stepId)) {
          return Promise.resolve();
        }
        if (!pass.pauses.has(stepId)) {
          noteFirstReach(stepId, durationMs);
        }
        return pending<void>();
      },

      waitForEvent: (stepId, waitOptions) => {
        if (finishedWaits.has(stepId)) {
          return Promise.resolve(finishedWaits.get(stepId));
        }
        if (!pass.pauses.has(stepId)) {
          noteFirstReach(stepId, waitOptions.timeoutMs ?? FALLBACK_TIMEOUT_MS);
          pass.waits.set(stepId, waitOptions);
        }
        return pending<unknown>();
      },
    };

    let returned: { value: T } | undefined;
    let threw: { error: unknown } | undefined;
    void body(runtime).then(
      (value) => {
        returned = { value };
      },
      (error: unknown) => {
        threw = { error };
      }
    );

    let idleTurns = 0;
    // eslint-disable-next-line eslint/no-unmodified-loop-condition -- both are assigned by the body's own settlement above
    while (idleTurns < QUIET_TURNS && !returned && !threw) {
      const before = discoveries;
      // eslint-disable-next-line eslint/no-await-in-loop -- turns are counted one after another, which is what measuring quiescence is
      await nextMacrotask();
      idleTurns = discoveries === before ? idleTurns + 1 : 0;
    }

    if (threw) {
      throw threw.error;
    }
    if (returned) {
      return {
        value: returned.value,
        executed,
        invocations: invocation + 1,
        elapsedMs: now,
      };
    }

    if (pass.runs.size === 0 && pass.pauses.size === 0) {
      throw new Error(
        `Replay invocation ${invocation} stopped without returning and without asking for a step. The body is blocked on something the runtime does not own.`
      );
    }

    // Steps a pass asked for all run before it is called again, which is the
    // whole of what parallel discovery buys. The stored value is JSON, since
    // that is what the next invocation reads back.
    for (const [stepId, fn] of pass.runs) {
      // eslint-disable-next-line eslint/no-await-in-loop -- running them in order is what gives `executed` a stable sequence for a test to read
      const value = await fn();
      memo.set(stepId, JSON.parse(JSON.stringify(value ?? null)));
      executed.push({ invocation, at: now, stepId });
    }

    advanceToLastPause({
      pass,
      wakeAt,
      events,
      finishedSleeps,
      finishedWaits,
      readClock: () => now,
      setClock: (value) => {
        now = value;
      },
    });

    invocation += 1;
  }

  throw new Error(
    `Replay gave up after ${maxInvocations} invocations. The graph is not converging.`
  );
}

/**
 * Ends every outstanding pause, and moves the clock to the last of them.
 *
 * This is the executor policy the driver exists to model, and both halves of it
 * were measured against `inngest dev` rather than read off the documentation.
 *
 * A run holding an outstanding pause gets no invocation of its own when a step
 * finishes: Inngest runs the steps the pass asked for and then waits, so every
 * other branch stops at its next step boundary. Two pauses outstanding together
 * give one wake, at the later target, whichever was registered first: a 20s
 * sleep beside a 90s sleep resumed 70 seconds past its own target. A pass
 * holding no pause is called again straight away, which is what leaves the clock
 * alone here.
 */
function advanceToLastPause(input: {
  pass: Pass;
  wakeAt: Map<string, number>;
  events: Record<string, unknown>;
  finishedSleeps: Set<string>;
  finishedWaits: Map<string, unknown>;
  readClock: () => number;
  setClock: (value: number) => void;
}) {
  const { pass, wakeAt, events, finishedSleeps, finishedWaits } = input;

  if (pass.pauses.size === 0) {
    return;
  }

  const times = [...pass.pauses].map((stepId) => wakeAt.get(stepId) ?? 0);
  input.setClock(Math.max(input.readClock(), ...times));

  for (const stepId of pass.pauses) {
    if (pass.waits.has(stepId)) {
      // A wait with no answer reached its timeout, and the engine reads that as
      // null.
      finishedWaits.set(stepId, events[stepId] ?? null);
    } else {
      finishedSleeps.add(stepId);
    }
  }
}
