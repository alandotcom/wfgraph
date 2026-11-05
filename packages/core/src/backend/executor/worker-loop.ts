/**
 * The database executor's worker loop: claim due schedule rows and run one pass
 * per claimed row, at most `concurrency` at once. It claims every `pollMs`, and
 * sooner when a run one of its own passes released falls due or its `wake` is
 * called. The Effect
 * succeeds once `signal` has aborted and every pass in flight has released its
 * row. A pass that fails is logged and leaves its row leased, so a later claim
 * sweeps it once the lease expires.
 */

import { Cause, Deferred, Effect, Exit, FiberSet } from "effect";
import { generateId } from "@wfgraph/shared/utils/id";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import { withAppLogCategory } from "#src/backend/lib/effect/app-logger";
import { runPass } from "#src/backend/executor/pass";
import {
  type ClaimedExecution,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
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

/** The persistence backend a loop claims from, which sets its default poll. */
export type WorkerBackend = "postgres" | "sqlite";

/**
 * How long a loop sleeps between claims when nothing wakes it sooner. A
 * PostgreSQL poll is a round trip to a server other processes also poll; a
 * SQLite claim is a local `BEGIN IMMEDIATE` that returns in microseconds.
 */
const DEFAULT_POLL_MS: Record<WorkerBackend, number> = {
  postgres: 1_000,
  sqlite: 250,
};

/**
 * The lease a claim takes. It is shorter than any platform's kill timeout, so a
 * worker that died is noticed before its host would have restarted it.
 */
const DEFAULT_LEASE_MS = 60_000;

/** How often a pass renews its lease while its body runs: three per lease. */
const DEFAULT_HEARTBEAT_MS = 20_000;

/** How many passes one loop runs at once. */
const DEFAULT_CONCURRENCY = 10;

export type WorkerLoopOptions = {
  backend: WorkerBackend;
  actions: WorkflowActions;
  entities?: WorkflowEntities | undefined;
  /** Aborting it stops the loop claiming; passes in flight run to their end. */
  signal: AbortSignal;
  /** Wakes the loop to claim at once, for a producer in the same process. */
  wake?: WorkerWake | undefined;
  /** Defaults to 1000 ms on PostgreSQL and 250 ms on SQLite. */
  pollMs?: number | undefined;
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
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS[options.backend];
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const workerId = options.workerId ?? `worker_${generateId()}`;
  const now = options.now ?? (() => new Date());
  const { signal } = options;

  // When each run a pass of this loop released is next due, by Execution id.
  // The loop claims at the earliest of these when it comes before the next
  // poll, so a Wait it parked resumes at its deadline. An entry is dropped once
  // its moment has come.
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

  /** Notes when a released run is due again, waking the loop if that is sooner. */
  const noteRelease = (executionId: string, wakeAt: Date) => {
    const soonest = earliest(releasedWakes);
    releasedWakes.set(executionId, wakeAt.getTime());
    if (soonest === undefined || wakeAt.getTime() < soonest) wakeNow();
  };

  /** Frees a pass's slot, waking the loop when it is waiting for one. */
  const freeSlot = () => {
    running -= 1;
    if (full) wakeNow();
  };

  /** One pass over one claimed row, logged as one record whatever it answers. */
  const passOver = (claimed: ClaimedExecution) => {
    const startedAt = Date.now();
    const pass = {
      execution: claimed.executionId,
      worker: workerId,
      attempt: claimed.attempt,
    };
    return runPass(claimed, {
      now,
      leaseMs,
      heartbeatMs,
      actions: options.actions,
      entities: options.entities,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if ("schedule" in result) {
            noteRelease(claimed.executionId, result.schedule.wakeAt);
          }
        })
      ),
      Effect.flatMap((result) =>
        Effect.logDebug(`Pass ${result.kind}`).pipe(
          Effect.annotateLogs({
            pass: { ...pass, outcome: result.kind, ms: Date.now() - startedAt },
          })
        )
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(
              "A pass failed; its run is claimed again once its lease expires"
            ).pipe(
              Effect.annotateLogs({
                pass: { ...pass, ms: Date.now() - startedAt },
                error: Cause.squash(cause),
              })
            )
      ),
      Effect.ensuring(Effect.sync(freeSlot))
    );
  };

  const loop = Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const passes = yield* FiberSet.make<void, never>();
    const { wake } = options;
    if (wake !== undefined) {
      yield* Effect.acquireRelease(
        Effect.sync(() => wake.subscribe(wakeNow)),
        (unsubscribe) => Effect.sync(unsubscribe)
      );
    }

    while (!signal.aborted) {
      wakeLoop = Deferred.makeUnsafe<void>();
      const claimAt = now();
      for (const [executionId, wakeAt] of releasedWakes) {
        if (wakeAt <= claimAt.getTime()) releasedWakes.delete(executionId);
      }

      const free = concurrency - running;
      full = free <= 0;
      if (free > 0) {
        const claimed = yield* executions
          .claimDue({ workerId, limit: free, leaseMs, now: claimAt })
          .pipe(
            Effect.catchTag("DatabaseError", (error) =>
              Effect.logError("Could not claim due runs").pipe(
                Effect.annotateLogs({ claim: { worker: workerId }, error }),
                Effect.as([])
              )
            )
          );
        full = claimed.length === free;
        for (const row of claimed) {
          running += 1;
          yield* FiberSet.run(passes, passOver(row));
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

    // The set's scope interrupts whatever is left in it when it closes, so the
    // loop waits for the set to drain before it returns.
    yield* FiberSet.awaitEmpty(passes);
  });

  return withAppLogCategory(Effect.scoped(loop), "executor");
}

/** The smallest of the map's values, or undefined for an empty map. */
function earliest(wakes: ReadonlyMap<string, number>): number | undefined {
  let soonest: number | undefined;
  for (const wakeAt of wakes.values()) {
    if (soonest === undefined || wakeAt < soonest) soonest = wakeAt;
  }
  return soonest;
}
