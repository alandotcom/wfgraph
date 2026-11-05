/**
 * The database executor's worker loop and the drain step it repeats. A drain
 * step claims due schedule rows and starts one leased pass per claimed row.
 * The loop runs a drain step every `pollMs`, sooner when a run one of its own
 * passes released falls due or its `wake` is called, and keeps at most
 * `concurrency` passes running. The loop's Effect succeeds once `signal` has
 * aborted and every pass in flight has ended, or once `drainMs` has passed and
 * the passes still running are interrupted. A pass that fails or is
 * interrupted leaves its row leased, so a later claim sweeps it once the lease
 * expires.
 */

import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  type Scope,
} from "effect";
import { generateId } from "@wfgraph/shared/utils/id";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import { withAppLogCategory } from "#src/backend/lib/effect/app-logger";
import {
  leasedPass,
  type PassBodies,
  type PassResult,
} from "#src/backend/executor/pass";
import { runBody } from "#src/backend/executor/run-body";
import {
  type ClaimedExecution,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
import { UNDATED_PARK_WAKE_AT } from "#src/backend/services/executions/repo/release-policy";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";

/**
 * Makes the worker loops it is handed to claim at once. A producer in the same
 * process calls `wake()` after committing a write that makes a run due, such as
 * a `resolvePark`, so the loop acts on it without waiting for its next poll. A
 * wake that lands while a loop is claiming makes it claim once more right after.
 */
export type WorkerWake = {
  wake: () => void;
  /** Calls `listener` on every wake until the returned function is called. */
  subscribe: (listener: () => void) => () => void;
};

export function createWorkerWake(): WorkerWake {
  const listeners = new Set<() => void>();
  return {
    wake: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The lease a claim takes. It is shorter than any platform's kill timeout, so a
 * worker that died is noticed before its host would have restarted it.
 */
const DEFAULT_LEASE_MS = 60_000;

/** How often a pass renews its lease while its body runs: three per lease. */
const DEFAULT_HEARTBEAT_MS = 20_000;

/** How many passes one loop runs at once. */
const DEFAULT_CONCURRENCY = 10;

/** What every drain step of one worker shares. */
export type DrainOptions<R> = {
  /** The body each claimed row's pass runs, by the row's kind. */
  bodies: PassBodies<R>;
  /** Written on each row the claim leases. */
  workerId: string;
  leaseMs: number;
  /** See `LeasedPassOptions.heartbeatMs`. */
  heartbeatMs?: number | undefined;
  /** The clock claims, leases and releases are stamped with. */
  now: () => Date;
};

/**
 * What one pass of a drain step came to.
 *
 * - `passed`: the pass ran to its end and answered `result`.
 * - `failed`: the pass failed or died, which was logged. Its row stays leased.
 * - `interrupted`: the pass was still running at the drain step's deadline.
 *   Its row stays leased.
 */
export type DrainedPass =
  | { kind: "passed"; claimed: ClaimedExecution; result: PassResult }
  | { kind: "failed"; claimed: ClaimedExecution }
  | { kind: "interrupted"; claimed: ClaimedExecution };

/**
 * One drain step: claims up to `limit` due rows and starts one pass over each
 * in the caller's scope. Answers a fiber per claimed row, in claim order, each
 * succeeding with what its pass came to. A pass still running at `deadline` is
 * interrupted, and closing the caller's scope interrupts every pass still
 * running. A claim the database fails is logged and claims nothing.
 */
export const drainOnce = Effect.fn("wfgraph.executor.drain")(function* <R>(
  options: DrainOptions<R>,
  step: { limit: number; deadline?: Date | undefined }
): Effect.fn.Return<
  Fiber.Fiber<DrainedPass>[],
  never,
  ExecutionRepo | Scope.Scope | R
> {
  const claimed = yield* claimDue({
    workerId: options.workerId,
    limit: step.limit,
    leaseMs: options.leaseMs,
    now: options.now(),
  });
  return yield* Effect.forEach(claimed, (row) =>
    Effect.forkScoped(drainPass(options, row, step.deadline))
  );
}, withExecutorLogCategory);

function withExecutorLogCategory<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return withAppLogCategory(effect, "executor");
}

/** Leases up to `limit` due rows to the worker; see `ExecutionRepo.claimDue`. */
const claimDue = Effect.fn("wfgraph.executor.claim")(function* (input: {
  workerId: string;
  limit: number;
  leaseMs: number;
  now: Date;
}) {
  yield* Effect.annotateCurrentSpan({
    "wfgraph.executor.worker": input.workerId,
    "wfgraph.executor.limit": input.limit,
  });
  const executions = yield* ExecutionRepo;
  const claimed = yield* executions
    .claimDue(input)
    .pipe(
      Effect.catchTag("DatabaseError", (error) =>
        Effect.logError("Could not claim due runs").pipe(
          Effect.annotateLogs({ claim: { worker: input.workerId }, error }),
          Effect.as([])
        )
      )
    );
  yield* Effect.annotateCurrentSpan("wfgraph.executor.claimed", claimed.length);
  return claimed;
});

/**
 * One claimed row's pass, as a drain step answers it. A pass that fails is
 * logged as one record; its row is claimed again once its lease expires.
 */
const drainPass = Effect.fnUntraced(function* <R>(
  options: DrainOptions<R>,
  claimed: ClaimedExecution,
  deadline: Date | undefined
): Effect.fn.Return<DrainedPass, never, ExecutionRepo | R> {
  const startedAt = yield* Clock.currentTimeMillis;
  const interrupted = Effect.succeed<DrainedPass>({
    kind: "interrupted",
    claimed,
  });
  const pass = leasedPass(claimed, options.bodies[claimed.kind], options).pipe(
    Effect.map((result): DrainedPass => ({ kind: "passed", claimed, result }))
  );
  const bounded =
    deadline === undefined
      ? pass
      : pass.pipe(
          Effect.timeoutOrElse({
            duration: Math.max(0, deadline.getTime() - options.now().getTime()),
            orElse: () => interrupted,
          })
        );
  return yield* bounded.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? interrupted
        : Effect.gen(function* () {
            const ms = (yield* Clock.currentTimeMillis) - startedAt;
            yield* Effect.logError(
              "A pass failed; its run is claimed again once its lease expires"
            ).pipe(
              Effect.annotateLogs({
                run: { execution: claimed.executionId },
                pass: {
                  worker: options.workerId,
                  attempt: claimed.attempt,
                  ms,
                },
                error: Cause.squash(cause),
              })
            );
            const failed: DrainedPass = { kind: "failed", claimed };
            return failed;
          })
    )
  );
});

export type WorkerLoopOptions = {
  actions: WorkflowActions;
  entities?: WorkflowEntities | undefined;
  /**
   * Aborting it stops the loop claiming. Passes in flight run to their end,
   * or until `drainMs` has passed.
   */
  signal: AbortSignal;
  /**
   * How long a stopped loop waits for its passes in flight before it
   * interrupts them, leaving their rows leased. Omitted, it waits for every
   * pass to end.
   */
  drainMs?: number | undefined;
  /** How long the loop sleeps between claims when nothing wakes it sooner. */
  pollMs: number;
  /** Wakes the loop to claim at once, for a producer in the same process. */
  wake?: WorkerWake | undefined;
  /** Defaults to 10. */
  concurrency?: number | undefined;
  /** Defaults to 60 s. */
  leaseMs?: number | undefined;
  /** Defaults to 20 s. */
  heartbeatMs?: number | undefined;
  /** Written on each row this loop leases. Defaults to a fresh id. */
  workerId?: string | undefined;
  /**
   * The clock claims and releases are stamped with. A Wait measures its
   * deadline from the wall clock, so a live loop keeps the default.
   */
  now?: (() => Date) | undefined;
};

/** Succeeds once `signal` aborts, at once when it already has. */
function stopRequested(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    // A signal that aborted already fires no event for a listener added now.
    if (signal.aborted) onAbort();
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

export function runWorkerLoop(
  options: WorkerLoopOptions
): Effect.Effect<void, never, ExecutionRepo | WorkflowRepo> {
  const { pollMs, signal } = options;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const now = options.now ?? (() => new Date());
  const drain: DrainOptions<ExecutionRepo | WorkflowRepo> = {
    bodies: {
      run: runBody({ actions: options.actions, entities: options.entities }),
    },
    workerId: options.workerId ?? `worker_${generateId()}`,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    now,
  };

  // When each run a pass of this loop released is next due, by Execution id.
  // The loop claims at the earliest of these when it comes before the next
  // poll, so a Wait it parked resumes at its deadline. An entry is dropped once
  // its moment has come, and a release with no deadline holds none.
  const releasedWakes = new Map<string, number>();
  // How many passes are running. A claim takes at most the remaining slots.
  let running = 0;
  // Whether the last claim took every free slot, so a due row may be waiting.
  let full = false;
  // Completed to cut the loop's current sleep short. Replaced at the top of
  // every iteration, before the claim, so completing it during a claim makes
  // the loop skip its sleep and claim again.
  let wakeLoop = Deferred.makeUnsafe<void>();
  const wakeNow = () => {
    Deferred.doneUnsafe(wakeLoop, Exit.void);
  };

  /**
   * Notes when a run a pass released is due again, waking the loop if that is
   * sooner than anything noted. A run released with no deadline, or ended,
   * holds no entry.
   */
  const noteRelease = (drained: DrainedPass) => {
    if (drained.kind !== "passed") return;
    const { executionId } = drained.claimed;
    const wakeAt =
      "schedule" in drained.result
        ? drained.result.schedule.wakeAt.getTime()
        : undefined;
    if (wakeAt === undefined || wakeAt >= UNDATED_PARK_WAKE_AT.getTime()) {
      releasedWakes.delete(executionId);
      return;
    }
    const soonest = earliest(releasedWakes);
    releasedWakes.set(executionId, wakeAt);
    if (soonest === undefined || wakeAt < soonest) wakeNow();
  };

  /** Frees a pass's slot, waking the loop when it is waiting for one. */
  const freeSlot = () => {
    running -= 1;
    if (full) wakeNow();
  };

  const loop = Effect.gen(function* () {
    // Each fiber here waits for one pass and then notes its release and frees
    // its slot, so the set is empty once every pass has ended.
    const settling = yield* FiberSet.make<void, never>();
    const { wake } = options;
    if (wake !== undefined) {
      yield* Effect.acquireRelease(
        Effect.sync(() => wake.subscribe(wakeNow)),
        (unsubscribe) => Effect.sync(unsubscribe)
      );
    }

    while (!signal.aborted) {
      wakeLoop = Deferred.makeUnsafe<void>();
      const claimAt = now().getTime();
      for (const [executionId, wakeAt] of releasedWakes) {
        if (wakeAt <= claimAt) releasedWakes.delete(executionId);
      }

      const free = concurrency - running;
      full = free <= 0;
      if (free > 0) {
        const passes = yield* drainOnce(drain, { limit: free });
        running += passes.length;
        full = passes.length === free;
        for (const pass of passes) {
          yield* FiberSet.run(
            settling,
            Fiber.await(pass).pipe(
              Effect.flatMap((exit) =>
                Effect.sync(() => {
                  if (Exit.isSuccess(exit)) noteRelease(exit.value);
                })
              ),
              Effect.ensuring(Effect.sync(freeSlot))
            )
          );
        }
      }

      // Sleep for one poll, or until the soonest released run is due, a pass
      // frees a slot the loop is waiting for, `wake` is called, or the stop
      // signal aborts. The poll finds every other due row, such as one another
      // process released.
      const soonest = earliest(releasedWakes);
      const untilSoonest =
        soonest === undefined ? pollMs : soonest - now().getTime();
      yield* Effect.raceFirst(
        stopRequested(signal),
        Deferred.await(wakeLoop)
      ).pipe(
        Effect.timeoutOrElse({
          duration: Math.max(0, Math.min(pollMs, untilSoonest)),
          orElse: () => Effect.void,
        })
      );
    }

    // Closing the loop's scope interrupts every pass still running, so the
    // loop first waits for them to end, for at most `drainMs` when it is set.
    const drained = FiberSet.awaitEmpty(settling);
    yield* options.drainMs === undefined
      ? drained
      : drained.pipe(
          Effect.timeoutOrElse({
            duration: options.drainMs,
            orElse: () => Effect.void,
          })
        );
  });

  return withExecutorLogCategory(Effect.scoped(loop));
}

/** The smallest of the map's values, or undefined for an empty map. */
function earliest(wakes: ReadonlyMap<string, number>): number | undefined {
  let soonest: number | undefined;
  for (const wakeAt of wakes.values()) {
    if (soonest === undefined || wakeAt < soonest) soonest = wakeAt;
  }
  return soonest;
}
