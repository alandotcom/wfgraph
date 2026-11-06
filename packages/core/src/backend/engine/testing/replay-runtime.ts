/**
 * A `WorkflowExecutionRuntime` driver that replays a body the way the database
 * executor (`executor/`) runs a run, for a test that has to see what a park
 * costs the rest of the graph on a virtual clock.
 *
 * One run per Execution, whose body runs in passes. A pass runs steps inline
 * and answers an open park with `parked`. A parked pass sleeps on the virtual
 * clock until any one park resolves, and the next pass replays the body from
 * the top against the step memo. A `ReplayDatabaseBackend` holds the memo and
 * the wakes: in memory by default, or over a real database in the replay suite
 * runners under `executor/testing/`.
 */

import {
  createInMemoryWorkflowRuntime,
  type WaitAnswer,
  type WaitWake,
  type WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";

/** One memoized step the driver ran, and when. */
export type ReplayExecution = {
  /** The run that ran it, which is always the one run of the drive. */
  run: string;
  /** Which pass of the body discovered it, counted from zero. */
  invocation: number;
  /** The virtual clock when it ran, in milliseconds from the start of the run. */
  at: number;
  stepId: string;
};

/**
 * Declares a replay suite's cases. The suite calls it with the in-memory
 * backend, and each replay suite runner calls it with a backend over a real
 * database.
 */
export type ReplayCases = (executor: ReplayExecutor) => void;

export type ReplayRunOptions = {
  /**
   * The wake that ends a park, keyed by the park's step id. A park with no
   * entry here runs to its timeout.
   */
  events?: Record<string, WaitWake> | undefined;
  /** Pass ceiling, which turns a non-converging graph into a failure. */
  maxInvocations?: number | undefined;
  /** How the executor is set up. Left out, an in-memory backend. */
  executor?: ReplayExecutor | undefined;
};

/** What a body is told about the pass it runs in. */
export type ReplayPass = {
  /** Which pass of the body this is, counted from zero. */
  invocation: number;
  /**
   * Resolves every park still open with `wake`, the way a producer writing to
   * the wait rows does in the middle of a pass, such as the store write that
   * wins an Exit claim.
   */
  signalOpenParks: (wake: WaitWake) => Promise<void>;
};

/** The run's body, called once per pass. */
export type ReplayBody<T> = (
  runtime: WorkflowExecutionRuntime,
  pass: ReplayPass
) => Promise<T>;

export type ReplayRun<T> = {
  value: T;
  /** Every step the driver ran, in order. */
  executed: ReplayExecution[];
  /** How many times the body was called from the top. */
  invocations: number;
  /** The virtual clock when the body returned, in milliseconds. */
  elapsedMs: number;
};

/**
 * Where the database executor keeps one drive's durable state: the step memo
 * and the wake each resolved park recorded.
 *
 * The default holds both in memory. A backend over a real database supplies a
 * runtime whose `run` reads and writes memo rows and whose `waitForEvent` reads
 * the park's wait row, and `resolvePark` writes the wake onto that row the way
 * a producer does.
 */
export type ReplayDatabaseBackend = {
  /**
   * The runtime one pass of the body runs against. Its `waitForEvent` answers
   * the wake `resolvePark` recorded for that step id, or `parked` while none is
   * recorded. The harness reads only `run`, `waitForEvent` and `attempt` from
   * it. `now` is the virtual clock in milliseconds, which a backend over a real
   * database hands its claim.
   */
  runtimeForPass: (pass: {
    invocation: number;
    now: number;
  }) => WorkflowExecutionRuntime | Promise<WorkflowExecutionRuntime>;
  /**
   * Records the wake a park resolved with, keyed by the step id it parked
   * under. Every pass after the call answers it. `now` is the virtual clock at
   * the moment the park resolves.
   */
  resolvePark: (
    stepId: string,
    wake: WaitWake,
    at: { now: number }
  ) => void | Promise<void>;
  /**
   * Hands the run back after a pass whose body ended parked, the way the
   * executor's release does. The harness still decides when the next pass
   * runs; a backend over a real database answers that pass's claim only if its
   * release agreed.
   */
  endParkedPass?:
    | ((pass: { invocation: number; now: number }) => void | Promise<void>)
    | undefined;
};

/** How one drive's executor is set up, as `ReplayRunOptions.executor`. */
export type ReplayExecutor = {
  /**
   * Opens the backend for one drive. Called once per `driveWithReplay`, so a
   * shared executor value never carries state from one case into the next.
   * Left out, `createInMemoryReplayBackend` is used. The replay suites' runners
   * set it to open a backend over PostgreSQL or SQLite.
   */
  openBackend?:
    | (() => ReplayDatabaseBackend | Promise<ReplayDatabaseBackend>)
    | undefined;
  /**
   * A producer that runs at one moment on the virtual clock while the run is
   * parked, the way a Cancel Event's handler does. `write` makes the producer's
   * own writes, such as the claim on the execution row, and then every park
   * still open resolves with `wake`. Parks reached after that moment are not
   * signaled.
   */
  signalOpenParksAt?:
    | {
        atMs: number;
        wake: WaitWake;
        write?: (() => void) | undefined;
      }
    | undefined;
};

/**
 * An event wait the engine left unbounded still has to end somewhere. A
 * backend that records a park's deadline gives such a park this one too.
 */
export const REPLAY_FALLBACK_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

/** How a park with no entry in `ReplayRunOptions.events` ends. */
export const TIMEOUT_WAKE: WaitWake = { kind: "timeout" };

const DEFAULT_MAX_INVOCATIONS = 200;

/** The name every `ReplayExecution` gives the one run of the drive. */
const RUN_ID = "root";

/** The backend the database executor uses when a case supplies none. */
export function createInMemoryReplayBackend(): ReplayDatabaseBackend {
  const memo = new Map<string, unknown>();
  const wakes = new Map<string, WaitWake>();

  return {
    runtimeForPass: () => {
      const { run, attempt } = createInMemoryWorkflowRuntime({ memo });
      return {
        attempt,
        run,
        waitForEvent: ({ id: stepId }) => {
          const wake = wakes.get(stepId);
          return Promise.resolve<WaitAnswer>(
            wake === undefined ? { kind: "parked" } : { kind: "woke", wake }
          );
        },
      };
    },
    resolvePark: (stepId, wake) => {
      wakes.set(stepId, wake);
    },
  };
}

/**
 * Whether a pass ended with the run still open. `executeWorkflow` answers
 * `kind: "parked"` for such a pass and `kind: "ended"` once it wrote the
 * terminal record, which is what the executor's release reads.
 */
function endedParked(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "parked"
  );
}

/**
 * Runs `body` in passes until one answers anything other than a parked result,
 * and answers with what it returned and every step the driver ran for it.
 *
 * Every pass calls the body from the top, which must build its own state each
 * time, as `executeWorkflow` does: it constructs a fresh `Traversal` per call
 * and recovers the rest from the memo. A body ends a pass by answering
 * `kind: "parked"`, which is what `executeWorkflow` answers while a Wait is
 * parked.
 *
 * Between passes the run sleeps until the earliest of its open parks reaches
 * its deadline, or until `signalOpenParksAt` fires. A park resolves at its
 * deadline with its entry in `events`, or with a timeout. A wake
 * that lands during a pass, after the pass read that park as parked, runs the
 * body again at once without moving the clock.
 *
 * A step whose function throws ends the drive with that error once the pass
 * settles, which is where the executor would end the invocation and retry it.
 */
export async function driveWithReplay<T>(
  body: ReplayBody<T>,
  options: ReplayRunOptions = {}
): Promise<ReplayRun<T>> {
  const {
    events = {},
    maxInvocations = DEFAULT_MAX_INVOCATIONS,
    executor = {},
  } = options;
  const backend = await (executor.openBackend ?? createInMemoryReplayBackend)();

  const executed: ReplayExecution[] = [];
  /** Each park's deadline on the virtual clock, fixed the first time it parks. */
  const deadlines = new Map<string, number>();
  /** Parks some pass read as parked, and that have not resolved since. */
  const openParks = new Set<string>();
  /** Parks resolved during the running pass whose wake that pass has not read. */
  const unreadWakes = new Set<string>();
  let pendingSignal = executor.signalOpenParksAt;
  let passRunning = false;
  let now = 0;

  async function resolvePark(stepId: string, wake: WaitWake) {
    openParks.delete(stepId);
    if (passRunning) {
      unreadWakes.add(stepId);
    }
    await backend.resolvePark(stepId, wake, { now });
  }

  async function signalOpenParks(wake: WaitWake) {
    // The producer writes to the parks open when it runs. A sibling branch of
    // the running pass can park while these writes are awaited, and that park
    // was not open yet, so the list is taken before the first write.
    const signaled = Array.from(openParks);
    for (const stepId of signaled) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one write per park, in a stable order, as a producer makes them
      await resolvePark(stepId, wake);
    }
  }

  /**
   * Moves the clock to the next moment a park resolves, and resolves every park
   * due by then. Answers false when nothing is left to wake the run.
   */
  async function advanceClock(): Promise<boolean> {
    const targets = [...openParks].flatMap((stepId) => {
      const deadline = deadlines.get(stepId);
      return deadline === undefined ? [] : [deadline];
    });
    if (pendingSignal && openParks.size > 0) {
      targets.push(pendingSignal.atMs);
    }
    if (targets.length === 0) {
      return false;
    }

    now = Math.max(now, Math.min(...targets));

    // `resolvePark` deletes the id being visited, and a Set iteration is
    // defined over exactly that. No pass runs here, so nothing else adds one.
    for (const stepId of openParks) {
      const deadline = deadlines.get(stepId);
      if (deadline !== undefined && deadline <= now) {
        // eslint-disable-next-line eslint/no-await-in-loop -- one write per park, in a stable order
        await resolvePark(stepId, events[stepId] ?? TIMEOUT_WAKE);
      }
    }

    const signal = pendingSignal;
    if (signal && signal.atMs <= now) {
      pendingSignal = undefined;
      signal.write?.();
      await signalOpenParks(signal.wake);
    }

    return true;
  }

  for (let invocation = 0; invocation < maxInvocations; invocation += 1) {
    // eslint-disable-next-line eslint/no-await-in-loop -- each pass runs against the runtime the backend opens for it
    const inner = await backend.runtimeForPass({ invocation, now });
    let stepFailure: { error: unknown } | undefined;

    const runtime: WorkflowExecutionRuntime = {
      attempt: inner.attempt,
      // The wrapper sees only a memo miss, because the backend calls `fn` for
      // a step it has no stored value for and for nothing else.
      run: (step, fn) =>
        inner.run(step, async () => {
          try {
            const value = await fn();
            executed.push({
              run: RUN_ID,
              invocation,
              at: now,
              stepId: step.id,
            });
            return value;
          } catch (error) {
            stepFailure ??= { error };
            throw error;
          }
        }),
      waitForEvent: async (step, waitOptions) => {
        const answer = await inner.waitForEvent(step, waitOptions);
        if (answer.kind === "parked") {
          if (!deadlines.has(step.id)) {
            const timeoutMs =
              waitOptions.timeoutMs ?? REPLAY_FALLBACK_TIMEOUT_MS;
            deadlines.set(step.id, now + Math.max(timeoutMs, 0));
          }
          openParks.add(step.id);
        } else {
          unreadWakes.delete(step.id);
        }
        return answer;
      },
    };

    unreadWakes.clear();
    passRunning = true;
    let settled: { value: T } | { error: unknown };
    try {
      // eslint-disable-next-line eslint/no-await-in-loop -- one pass at a time is what gives the virtual clock a single reader
      settled = { value: await body(runtime, { invocation, signalOpenParks }) };
    } catch (error) {
      settled = { error };
    } finally {
      passRunning = false;
    }

    if (stepFailure) {
      throw stepFailure.error;
    }
    if ("error" in settled) {
      throw settled.error;
    }
    if (!endedParked(settled.value)) {
      return {
        value: settled.value,
        executed,
        invocations: invocation + 1,
        elapsedMs: now,
      };
    }

    // eslint-disable-next-line eslint/no-await-in-loop -- the release follows its own pass
    await backend.endParkedPass?.({ invocation, now });

    // A wake that landed while the pass ran re-queues the run at once.
    if (unreadWakes.size > 0) {
      continue;
    }

    // eslint-disable-next-line eslint/no-await-in-loop -- the clock moves only between passes
    if (!(await advanceClock())) {
      throw new Error(
        `Replay pass ${invocation} ended parked with no open park left to wake the run.`
      );
    }
  }

  throw new Error(
    `Replay gave up after ${maxInvocations} invocations. The graph is not converging.`
  );
}
