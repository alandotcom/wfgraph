/**
 * The database executor as `driveWithReplay` models it: one run per Execution,
 * whose body runs in passes. A pass runs steps inline and answers an open park
 * with `PARKED_WAIT_ANSWER`. A parked pass sleeps on the virtual clock until any
 * one park resolves. A `ReplayDatabaseBackend` holds the memo and the wakes.
 */

import {
  createInMemoryWorkflowRuntime,
  isParkedWaitAnswer,
  PARKED_WAIT_ANSWER,
  type WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import type {
  ReplayBody,
  ReplayExecution,
  ReplayRun,
  ReplayRunOptions,
} from "#src/backend/engine/testing/replay-runtime";

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
   * the wake `resolvePark` recorded for that step id, or `PARKED_WAIT_ANSWER`
   * while none is recorded. The harness reads only `run`, `waitForEvent`,
   * `attempt` and `runId` from it, so a branch hand-off is never offered.
   */
  runtimeForPass: (pass: {
    invocation: number;
  }) => WorkflowExecutionRuntime | Promise<WorkflowExecutionRuntime>;
  /**
   * Records what a park resolved to, keyed by the step id it parked under: the
   * signal event, or `null` for a timeout. Every pass after the call answers it.
   */
  resolvePark: (stepId: string, wake: unknown) => void | Promise<void>;
};

/** The database executor, as a `ReplayRunOptions.executor` value. */
export type DatabaseReplayExecutor = {
  kind: "database";
  /**
   * Opens the backend for one drive. Called once per `driveWithReplay`, so a
   * shared executor value never carries state from one case into the next.
   * Left out, `createInMemoryReplayBackend` is used.
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
        wake: unknown;
        write?: (() => void) | undefined;
      }
    | undefined;
};

/** An event wait the engine left unbounded still has to end somewhere. */
const FALLBACK_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_INVOCATIONS = 200;

/** The one run's id, matching the root run of the Inngest model. */
const RUN_ID = "root";

/** The backend the database executor uses when a case supplies none. */
export function createInMemoryReplayBackend(): ReplayDatabaseBackend {
  const memo = new Map<string, unknown>();
  const wakes = new Map<string, unknown>();

  return {
    runtimeForPass: () => {
      const { run, attempt } = createInMemoryWorkflowRuntime({ memo });
      return {
        attempt,
        runId: RUN_ID,
        run,
        waitForEvent: ({ id: stepId }) =>
          Promise.resolve(
            wakes.has(stepId) ? wakes.get(stepId) : PARKED_WAIT_ANSWER
          ),
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
 * Runs `body` in passes until one answers anything other than a parked result.
 *
 * Between passes the run sleeps until the earliest of its open parks reaches
 * its deadline, or until `signalOpenParksAt` fires. A park resolves at its
 * deadline with its entry in `events`, or with `null` for a timeout. A wake
 * that lands during a pass, after the pass read that park as parked, runs the
 * body again at once without moving the clock.
 *
 * A step whose function throws ends the drive with that error once the pass
 * settles, which is where the executor would end the invocation and retry it.
 */
export async function driveDatabaseExecutor<T>(
  body: ReplayBody<T>,
  options: ReplayRunOptions,
  executor: DatabaseReplayExecutor
): Promise<ReplayRun<T>> {
  const { events = {}, maxInvocations = DEFAULT_MAX_INVOCATIONS } = options;
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

  async function resolvePark(stepId: string, wake: unknown) {
    openParks.delete(stepId);
    if (passRunning) {
      unreadWakes.add(stepId);
    }
    await backend.resolvePark(stepId, wake);
  }

  async function signalOpenParks(wake: unknown) {
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
        await resolvePark(stepId, events[stepId] ?? null);
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
    const inner = await backend.runtimeForPass({ invocation });
    let stepFailure: { error: unknown } | undefined;

    const runtime: WorkflowExecutionRuntime = {
      attempt: inner.attempt,
      runId: inner.runId,
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
        if (isParkedWaitAnswer(answer)) {
          if (!deadlines.has(step.id)) {
            const timeoutMs = waitOptions.timeoutMs ?? FALLBACK_TIMEOUT_MS;
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
        runs: 1,
        elapsedMs: now,
      };
    }

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
