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
 * It owns a set of runs rather than one body, because a Wait is handed to a
 * durable run of its own and the whole question is what one run's pause costs
 * another. Each run carries its own memo and its own pauses, and the executor
 * policy below applies per run.
 *
 * That policy is Inngest's, read off a dev-server trace rather than off its
 * documentation. `docs/adr/0004` covers why Inngest is the substrate; the policy
 * itself is stated at `endTimersDueNow`.
 */

import type {
  BranchHandoff,
  BranchRunResult,
} from "#src/backend/engine/branch";
import { ReplayHostTimers } from "#src/backend/engine/testing/replay-host-timers";
import type {
  DurableStepRef,
  WaitForEventOptions,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";

/** One memoized step the driver ran, and where in the run tree it ran. */
export type ReplayExecution = {
  /** Which durable run ran it: `root`, or the step id that started the branch. */
  run: string;
  /** Which invocation of that run's body discovered it, counted from zero. */
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
  events?: Record<string, unknown> | undefined;
  /** Invocation ceiling, which turns a non-converging graph into a failure. */
  maxInvocations?: number | undefined;
  /**
   * The body a branch hand-off starts. Left out, the runtime offers no
   * `startBranch` at all, which is what the engine reads as "run the Wait
   * here".
   */
  branch?: (
    runtime: WorkflowExecutionRuntime,
    input: { entryNodeId: string; releasedNodeIds: readonly string[] }
  ) => Promise<unknown>;
  /**
   * Virtual clock at which every live branch run is killed, which is what a
   * cancellation does to them. The run that started one reads `killed` back.
   */
  killBranchesAtMs?: number | undefined;
};

export type ReplayRun<T> = {
  value: T;
  /** Every step the driver ran, in order, across every run. */
  executed: ReplayExecution[];
  /** How many times a body was called from the top, across every run. */
  invocations: number;
  /** How many durable runs the tree took, the root included. */
  runs: number;
  /** The virtual clock when the root body returned, in milliseconds. */
  elapsedMs: number;
};

/** An event wait the engine left unbounded still has to end somewhere. */
const FALLBACK_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_INVOCATIONS = 200;

const ROOT_RUN_ID = "root";

/** Tells the run that started this one how it ended, which is what wakes it. */
function reportToParent(run: DurableRun, ending: BranchEnding) {
  const { parent } = run;
  if (!parent) {
    return;
  }

  parent.run.branchEndings.set(parent.stepId, ending);
  parent.run.outstanding.delete(parent.stepId);
}

/** A settled body as the run that started it reads it. */
function endingOf(settlement: Settlement): BranchEnding {
  return "error" in settlement
    ? settlement
    : {
        handoff: {
          status: "finished",
          // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a branch body answers with what the run that started it reads back
          result: settlement.value as BranchRunResult,
        },
      };
}

/** A step the current pass has to discover rather than answer. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Resolved by the next invocation reading the memo, never by this one.
  });
}

/**
 * Waits until the body is settled or every live branch is parked on a step the
 * driver owns. Host immediates between step calls land on `timers`, so draining
 * it is what makes "parked" observable rather than inferred from quiet turns.
 *
 * `activity` rises on every runtime port call, including memo hits: the replay
 * half of a pass does its work there, and discoveries alone would not see it.
 */
async function waitForPassQuiescence(
  timers: ReplayHostTimers,
  isSettled: () => boolean,
  activity: () => number
): Promise<void> {
  while (!isSettled()) {
    const before = activity();
    // eslint-disable-next-line eslint/no-await-in-loop -- each drain may enqueue the next hop the body takes before its next step call
    await timers.drainUntilIdle();
    // eslint-disable-next-line eslint/no-await-in-loop -- one microtask turn lets a memo hit's continuation reach the next port call
    await Promise.resolve();
    if (activity() !== before || timers.hasPending()) {
      continue;
    }
    return;
  }
}

/** What one invocation of one body left behind. */
type Pass = {
  /** Steps this pass asked for, in the order it asked. */
  readonly runs: Map<string, () => Promise<unknown>>;
  /** Sleeps, event waits and branch hand-offs this pass is blocked on. */
  readonly pauses: Set<string>;
};

/** How a body ended: the two ways a promise can settle. */
type Settlement = { value: unknown } | { error: unknown };

/** How a branch ended, as the run that started it reads it back. */
type BranchEnding = { handoff: BranchHandoff } | { error: unknown };

/** One durable run of the tree, with everything that survives its replays. */
type DurableRun = {
  readonly id: string;
  readonly body: (runtime: WorkflowExecutionRuntime) => Promise<unknown>;
  readonly memo: Map<string, unknown>;
  readonly finishedSleeps: Set<string>;
  readonly finishedWaits: Map<string, unknown>;
  /** When each pause fires, fixed the first time this run reaches it. */
  readonly wakeAt: Map<string, number>;
  /** Which pauses are event waits, so an ended one resolves to its answer. */
  readonly eventWaits: Set<string>;
  /** The step ids this run has started a branch under. */
  readonly branchRuns: Set<string>;
  /** How each of those branches ended, once one has. */
  readonly branchEndings: Map<string, BranchEnding>;
  /** The run that started this one, absent on the root. */
  readonly parent?: { run: DurableRun; stepId: string } | undefined;
  /** Pauses the last pass is blocked on that have yet to end. */
  outstanding: Set<string>;
  invocation: number;
  settled?: Settlement | undefined;
};

/**
 * Runs `body` to completion across as many invocations and as many runs as it
 * takes, and answers with what it returned and everything the driver had to run
 * on its behalf.
 *
 * Every body is called once per invocation and must build its own state each
 * time, which is what the engine does: `executeWorkflow` constructs a fresh
 * `Traversal` per call and recovers the rest from the memo.
 */
export async function driveWithReplay<T>(
  body: (runtime: WorkflowExecutionRuntime) => Promise<T>,
  options: ReplayRunOptions = {}
): Promise<ReplayRun<T>> {
  const timers = new ReplayHostTimers();
  timers.install();
  try {
    return await driveWithReplayInstalled(body, options, timers);
  } finally {
    timers.uninstall();
  }
}

async function driveWithReplayInstalled<T>(
  body: (runtime: WorkflowExecutionRuntime) => Promise<T>,
  options: ReplayRunOptions,
  timers: ReplayHostTimers
): Promise<ReplayRun<T>> {
  const {
    events = {},
    maxInvocations = DEFAULT_MAX_INVOCATIONS,
    branch,
    killBranchesAtMs,
  } = options;

  const tree: DurableRun[] = [];
  const executed: ReplayExecution[] = [];
  let now = 0;
  let invocations = 0;

  function startRun(
    id: string,
    runBody: (runtime: WorkflowExecutionRuntime) => Promise<unknown>,
    parent?: { run: DurableRun; stepId: string }
  ): DurableRun {
    const run: DurableRun = {
      id,
      body: runBody,
      memo: new Map(),
      finishedSleeps: new Set(),
      finishedWaits: new Map(),
      wakeAt: new Map(),
      eventWaits: new Set(),
      branchRuns: new Set(),
      branchEndings: new Map(),
      parent,
      outstanding: new Set(),
      invocation: 0,
    };
    tree.push(run);
    return run;
  }

  /** Ends one pause, which is what lets the run that holds it be called again. */
  function endPause(run: DurableRun, stepId: string) {
    if (run.eventWaits.has(stepId)) {
      // A wait with no answer reached its timeout, which the engine reads as
      // null.
      run.finishedWaits.set(stepId, events[stepId] ?? null);
    } else {
      run.finishedSleeps.add(stepId);
    }
    run.outstanding.delete(stepId);
  }

  /**
   * Ends every timer this run is holding whose target the clock has reached.
   *
   * A run stays parked until the last of its outstanding pauses ends, which is
   * the executor policy measured against `inngest dev`: two pauses outstanding
   * together give one wake, at the later target, whichever was registered
   * first. A 20-second sleep beside a 90-second one resumed 70 seconds past its
   * own target. What that measurement is about is one run: a pause held by
   * another run stops nothing here, which is the whole of why a waiting branch
   * gets a run of its own.
   */
  function endTimersDueNow(run: DurableRun) {
    // `endPause` deletes the id it was given, which is the one being visited,
    // and a Set iteration is defined over exactly that.
    for (const stepId of run.outstanding) {
      const target = run.wakeAt.get(stepId);
      if (target !== undefined && target <= now) {
        endPause(run, stepId);
      }
    }
  }

  /** Ends every branch run that is still going, as a cancellation does. */
  function killLiveBranches() {
    for (const run of tree) {
      if (!run.parent || run.settled) {
        continue;
      }
      run.settled = { value: null };
      reportToParent(run, { handoff: { status: "killed" } });
    }
  }

  /**
   * Moves the clock to the next moment anything is waiting for, and answers
   * false when nothing is: a tree blocked on a step no run asked for.
   */
  function advanceClock(): boolean {
    const targets: number[] = [];

    for (const run of tree) {
      if (run.settled) {
        continue;
      }
      for (const stepId of run.outstanding) {
        const target = run.wakeAt.get(stepId);
        if (target !== undefined) {
          targets.push(target);
        }
      }
    }

    const liveBranches = tree.some((run) => run.parent && !run.settled);
    if (
      killBranchesAtMs !== undefined &&
      killBranchesAtMs > now &&
      liveBranches
    ) {
      targets.push(killBranchesAtMs);
    }

    if (targets.length === 0) {
      return false;
    }

    now = Math.max(now, Math.min(...targets));

    for (const run of tree) {
      if (!run.settled) {
        endTimersDueNow(run);
      }
    }

    if (killBranchesAtMs !== undefined && now >= killBranchesAtMs) {
      killLiveBranches();
    }

    return true;
  }

  /** Calls one run's body from the top, and settles or parks it. */
  async function invokeOnce(run: DurableRun): Promise<void> {
    const pass: Pass = { runs: new Map(), pauses: new Set() };
    let activity = 0;

    /**
     * Every runtime port call counts, including memo hits: discoveries alone
     * miss the replay half of a pass.
     */
    const withActivity = <Value>(fn: () => Value): Value => {
      activity += 1;
      return fn();
    };

    const noteFirstReach = (stepId: string, durationMs: number) => {
      if (!run.wakeAt.has(stepId)) {
        run.wakeAt.set(stepId, now + Math.max(durationMs, 0));
      }
      pass.pauses.add(stepId);
    };

    const runtime: WorkflowExecutionRuntime = {
      attempt: 0,
      runId: run.id,

      // Only the id is read here. A step's display name is for a durable
      // runtime's UI, and this runtime has none.
      run: <R>(
        { id: stepId }: DurableStepRef,
        fn: () => Promise<R>
      ): Promise<R> =>
        withActivity(() => {
          if (run.memo.has(stepId)) {
            // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a step id always maps back to that step's own result type
            return Promise.resolve(run.memo.get(stepId) as R);
          }
          if (!pass.runs.has(stepId)) {
            pass.runs.set(stepId, fn);
          }
          return pending<R>();
        }),

      sleep: ({ id: stepId }, durationMs) =>
        withActivity(() => {
          if (run.finishedSleeps.has(stepId)) {
            return Promise.resolve();
          }
          if (!pass.pauses.has(stepId)) {
            noteFirstReach(stepId, durationMs);
          }
          return pending<void>();
        }),

      waitForEvent: ({ id: stepId }, waitOptions: WaitForEventOptions) =>
        withActivity(() => {
          if (run.finishedWaits.has(stepId)) {
            return Promise.resolve(run.finishedWaits.get(stepId));
          }
          if (!pass.pauses.has(stepId)) {
            run.eventWaits.add(stepId);
            noteFirstReach(
              stepId,
              waitOptions.timeoutMs ?? FALLBACK_TIMEOUT_MS
            );
          }
          return pending<unknown>();
        }),

      ...(branch
        ? {
            startBranch: (
              { id: stepId }: DurableStepRef,
              input: {
                entryNodeId: string;
                releasedNodeIds: readonly string[];
              }
            ) =>
              withActivity(() => {
                const ended = run.branchEndings.get(stepId);
                if (ended) {
                  return "error" in ended
                    ? Promise.reject(ended.error)
                    : Promise.resolve(ended.handoff);
                }
                if (!run.branchRuns.has(stepId)) {
                  run.branchRuns.add(stepId);
                  startRun(
                    stepId,
                    (childRuntime) => branch(childRuntime, input),
                    {
                      run,
                      stepId,
                    }
                  );
                }
                pass.pauses.add(stepId);
                return pending<BranchHandoff>();
              }),
          }
        : {}),
    };

    let settlement: Settlement | undefined;
    void run.body(runtime).then(
      (value) => {
        settlement = { value };
      },
      (error: unknown) => {
        settlement = { error };
      }
    );

    await waitForPassQuiescence(
      timers,
      () => settlement !== undefined,
      () => activity
    );

    const invocation = run.invocation;
    run.invocation += 1;
    invocations += 1;

    if (settlement) {
      run.settled = settlement;
      reportToParent(run, endingOf(settlement));
      return;
    }

    if (pass.runs.size === 0 && pass.pauses.size === 0) {
      throw new Error(
        `Replay run "${run.id}" stopped at invocation ${invocation} without returning and without asking for a step. The body is blocked on something the runtime does not own.`
      );
    }

    // Steps a pass asked for all run before that run is called again, which is
    // the whole of what parallel discovery buys. The stored value is JSON,
    // because that is what the next invocation reads back. Host timers inside a
    // step callback use the real clock, not the pass queue.
    for (const [stepId, fn] of pass.runs) {
      // eslint-disable-next-line eslint/no-await-in-loop -- running them in order is what gives `executed` a stable sequence for a test to read
      const value = await timers.withHostTimers(fn);
      run.memo.set(stepId, JSON.parse(JSON.stringify(value ?? null)));
      executed.push({ run: run.id, invocation, at: now, stepId });
    }

    run.outstanding = new Set(pass.pauses);
    endTimersDueNow(run);
  }

  const root = startRun(ROOT_RUN_ID, body);

  while (invocations < maxInvocations) {
    const runnable = tree.filter(
      (run) => !run.settled && run.outstanding.size === 0
    );

    if (runnable.length === 0) {
      if (!advanceClock()) {
        throw new Error(
          "Replay stopped with every run parked and nothing left to wake them."
        );
      }
      continue;
    }

    for (const run of runnable) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one pass at a time is what gives the virtual clock a single reader
      await invokeOnce(run);
      if (root.settled) {
        break;
      }
    }

    if (root.settled) {
      if ("error" in root.settled) {
        throw root.settled.error;
      }
      return {
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the root body is the caller's own, so its value is the one they typed
        value: root.settled.value as T,
        executed,
        invocations,
        runs: tree.length,
        elapsedMs: now,
      };
    }
  }

  throw new Error(
    `Replay gave up after ${maxInvocations} invocations. The graph is not converging.`
  );
}
