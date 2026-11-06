/**
 * The database executor's worker loop, the drain step it repeats, and `tick`,
 * drain steps within a budget for a host with no long-lived process. A
 * drain step claims due schedule rows in lanes, one lane per kind, each with
 * its own slots (`concurrency` for runs, `deliveryConcurrency` for
 * deliveries), so a long run never holds back an Event's delivery; one claim
 * answers every lane. It starts one leased pass per claimed row. The loop runs
 * a drain step every `pollMs`, sooner when a row one of its own passes
 * released falls due or its `wake` is called. The loop and `tick` both keep
 * the event inbox through `inboxUpkeep`: a poll that schedules the rows a host
 * inserted itself, and a sweep that deletes settled rows past `retentionMs`.
 * The loop's Effect succeeds once `signal` has aborted and every pass in
 * flight has ended, or once `drainMs` has passed and the passes still running
 * are interrupted. A pass that fails leaves its row leased, so a later claim
 * sweeps it once the lease expires. An interrupted pass releases its row due
 * at once and counts no failure.
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
import { countBy, groupBy } from "es-toolkit/array";
import { sumBy } from "es-toolkit/math";
import { generateId } from "@wfgraph/shared/utils/id";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import { withAppLogCategory } from "#src/backend/lib/effect/app-logger";
import {
  leasedPass,
  passAnnotations,
  type PassBodies,
  type PassResult,
} from "#src/backend/executor/pass";
import { runBody } from "#src/backend/executor/run-body";
import {
  deliveryBody,
  type DeliveryServices,
} from "#src/backend/executor/delivery-body";
import {
  type ClaimedSchedule,
  type ClaimLane,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
import { UNDATED_PARK_WAKE_AT } from "#src/backend/services/executions/repo/release-policy";
import type { WorkflowRepo } from "#src/backend/services/workflows/repo";
import type { WorkerWake } from "#src/backend/executor/worker-wake";

/**
 * The lease a claim takes. It is shorter than any platform's kill timeout, so a
 * worker that died is noticed before its host would have restarted it.
 */
export const DEFAULT_LEASE_MS = 60_000;

/** How often a pass renews its lease while its body runs: three per lease. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** How many host-inserted inbox rows one poll schedules at most. */
const INBOX_POLL_LIMIT = 100;

/** How often a loop deletes settled inbox rows past the retention window. */
const INBOX_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How many inbox rows one sweep deletes at most, in one statement. A sweep
 * that reaches it leaves more rows past the window, and the next one runs a
 * poll interval later.
 */
const INBOX_SWEEP_LIMIT = 1_000;

/** Every service a worker's passes read. */
export type ExecutorServices = ExecutionRepo | WorkflowRepo | DeliveryServices;

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
 *   It released its row due at once, counting no failure.
 */
export type DrainedPass =
  | { kind: "passed"; claimed: ClaimedSchedule; result: PassResult }
  | { kind: "failed"; claimed: ClaimedSchedule }
  | { kind: "interrupted"; claimed: ClaimedSchedule };

/** One pass a drain step started: the row it claimed, and the pass's fiber. */
export type StartedPass = {
  claimed: ClaimedSchedule;
  fiber: Fiber.Fiber<DrainedPass>;
};

/**
 * `effect`, or `fallback` once `abandon` succeeds first. With no `abandon`,
 * `effect` alone.
 */
function raceAbandon<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  abandon: Effect.Effect<void> | undefined,
  fallback: A
): Effect.Effect<A, E, R> {
  return abandon === undefined
    ? effect
    : Effect.raceFirst(effect, abandon.pipe(Effect.as(fallback)));
}

/**
 * One drain step: one claim of up to each lane's `limit` due rows of the
 * lane's kind, and one pass over each claimed row in the caller's scope,
 * started lane by lane in `lanes` order. A pass still running at `deadline`
 * is interrupted, and closing the caller's scope interrupts every pass still
 * running. A claim the database fails is logged and claims nothing, and so is
 * a claim still waiting on the database when `abandon` succeeds. A claim that
 * commits after it was abandoned leaves its rows leased until their leases
 * expire.
 */
export const drainOnce = Effect.fn("wfgraph.executor.drain")(function* <R>(
  options: DrainOptions<R>,
  step: {
    lanes: readonly ClaimLane[];
    deadline?: Date | undefined;
    abandon?: Effect.Effect<void> | undefined;
  }
): Effect.fn.Return<StartedPass[], never, ExecutionRepo | Scope.Scope | R> {
  const claimed = yield* raceAbandon(
    claimDue({
      lanes: step.lanes,
      workerId: options.workerId,
      leaseMs: options.leaseMs,
      now: options.now(),
    }),
    step.abandon,
    []
  );
  const byKind = groupBy(claimed, (row) => row.kind);
  const inLaneOrder = step.lanes.flatMap((lane) => byKind[lane.kind] ?? []);
  return yield* Effect.forEach(inLaneOrder, (row) =>
    Effect.forkScoped(drainPass(options, row, step.deadline)).pipe(
      Effect.map((fiber): StartedPass => ({ claimed: row, fiber }))
    )
  );
}, withExecutorLogCategory);

function withExecutorLogCategory<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return withAppLogCategory(effect, "executor");
}

/** Leases due rows to the worker in every lane at once; see `ExecutionRepo.claimDue`. */
const claimDue = Effect.fn("wfgraph.executor.claim")(function* (input: {
  lanes: readonly ClaimLane[];
  workerId: string;
  leaseMs: number;
  now: Date;
}) {
  yield* Effect.annotateCurrentSpan({
    "wfgraph.executor.worker": input.workerId,
    ...Object.fromEntries(
      input.lanes.map((lane) => [
        `wfgraph.executor.limit.${lane.kind}`,
        lane.limit,
      ])
    ),
  });
  const executions = yield* ExecutionRepo;
  const claimed = yield* executions.claimDue(input).pipe(
    Effect.catchTag("DatabaseError", (error) =>
      Effect.logError("Could not claim due schedule rows").pipe(
        Effect.annotateLogs({
          claim: {
            worker: input.workerId,
            lanes: input.lanes.map((lane) => lane.kind),
          },
          error,
        }),
        Effect.as([])
      )
    )
  );
  const counts = countBy(claimed, (row) => row.kind);
  yield* Effect.annotateCurrentSpan(
    Object.fromEntries(
      input.lanes.map((lane) => [
        `wfgraph.executor.claimed.${lane.kind}`,
        counts[lane.kind] ?? 0,
      ])
    )
  );
  return claimed;
});

/**
 * One claimed row's pass, as a drain step answers it. A pass that fails is
 * logged as one record; its row is claimed again once its lease expires. The
 * pass first yields to the event loop, so timers and I/O callbacks that fell
 * due while the previous pass replayed run before this one starts.
 */
const drainPass = Effect.fnUntraced(function* <R>(
  options: DrainOptions<R>,
  claimed: ClaimedSchedule,
  deadline: Date | undefined
): Effect.fn.Return<DrainedPass, never, ExecutionRepo | R> {
  const startedAt = yield* Clock.currentTimeMillis;
  const interrupted = Effect.succeed<DrainedPass>({
    kind: "interrupted",
    claimed,
  });
  const pass = Effect.yieldNow.pipe(
    Effect.andThen(leasedPass(claimed, options.bodies, options)),
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
            const annotations = passAnnotations(claimed, options.workerId);
            yield* Effect.logError(
              "A pass failed; its row is claimed again once its lease expires"
            ).pipe(
              Effect.annotateLogs({
                ...annotations,
                pass: { ...annotations.pass, ms },
                error: Cause.squash(cause),
              })
            );
            const failed: DrainedPass = { kind: "failed", claimed };
            return failed;
          })
    )
  );
});

/**
 * The poll for inbox rows a host inserted inside its own transaction: gives up
 * to `INBOX_POLL_LIMIT` of them their delivery schedule rows, due at `now`, so
 * the claim that follows finds them. A poll the database fails is logged, and
 * the next one finds the same rows.
 */
const scheduleHostInsertedInbox = Effect.fn("wfgraph.executor.poll_inbox")(
  function* (now: Date) {
    yield* Effect.annotateCurrentSpan(
      "wfgraph.executor.limit",
      INBOX_POLL_LIMIT
    );
    const executions = yield* ExecutionRepo;
    const scheduled = yield* executions
      .scheduleUnscheduledInbox({ now, limit: INBOX_POLL_LIMIT })
      .pipe(
        Effect.catchTag("DatabaseError", (error) =>
          Effect.logError(
            "Could not schedule the inbox rows a host inserted"
          ).pipe(Effect.annotateLogs({ error }), Effect.as([]))
        )
      );
    yield* Effect.annotateCurrentSpan(
      "wfgraph.executor.scheduled",
      scheduled.length
    );
  }
);

/**
 * The retention sweep: deletes up to `INBOX_SWEEP_LIMIT` delivered or failed
 * inbox rows that arrived more than `retentionMs` before `now`, and answers
 * how many went. A `pending` row is never deleted. A sweep the database fails
 * is logged and answers 0.
 */
const sweepSettledInbox = Effect.fn("wfgraph.executor.sweep_inbox")(
  function* (input: { now: Date; retentionMs: number }) {
    const olderThan = new Date(input.now.getTime() - input.retentionMs);
    yield* Effect.annotateCurrentSpan({
      "wfgraph.executor.limit": INBOX_SWEEP_LIMIT,
      "wfgraph.executor.retention_ms": input.retentionMs,
      "wfgraph.executor.cutoff": olderThan.toISOString(),
    });
    const executions = yield* ExecutionRepo;
    const swept = yield* executions
      .sweepSettledInbox({ olderThan, limit: INBOX_SWEEP_LIMIT })
      .pipe(
        Effect.catchTag("DatabaseError", (error) =>
          Effect.logError(
            "Could not delete the settled inbox rows past the retention window"
          ).pipe(Effect.annotateLogs({ error }), Effect.as(0))
        )
      );
    yield* Effect.annotateCurrentSpan("wfgraph.executor.swept", swept);
    if (swept > 0) {
      yield* Effect.logInfo(
        "Deleted settled inbox rows past the retention window"
      ).pipe(
        Effect.annotateLogs({
          inbox: { swept, retentionMs: input.retentionMs },
        })
      );
    }
    return swept;
  }
);

/**
 * The event inbox's upkeep for one worker loop or one tick, which keeps its
 * own timing so its caller can ask for both halves on every iteration.
 */
export type InboxUpkeep = {
  /**
   * Schedules the inbox rows a host inserted itself, when `pollMs` has passed
   * since the last poll, and otherwise does nothing.
   */
  readonly poll: (now: Date) => Effect.Effect<void, never, ExecutionRepo>;
  /**
   * The retention sweep due at `now`, for the caller to run or fork, or
   * undefined while one is running or none is due. A sweep runs once an hour,
   * and a poll interval after one that reached its limit or did not finish.
   */
  readonly sweepDue: (
    now: Date
  ) => Effect.Effect<void, never, ExecutionRepo> | undefined;
};

/**
 * The upkeep of one loop or tick. A new upkeep polls and sweeps at its first
 * call, so a tick, which builds one per invocation, polls and sweeps every
 * time it runs.
 */
export function inboxUpkeep(input: {
  pollMs: number;
  retentionMs: number;
}): InboxUpkeep {
  const { pollMs, retentionMs } = input;
  let polledAt = Number.NEGATIVE_INFINITY;
  let sweepAt = Number.NEGATIVE_INFINITY;
  return {
    poll: (now) =>
      Effect.suspend(() => {
        if (now.getTime() - polledAt < pollMs) return Effect.void;
        polledAt = now.getTime();
        return scheduleHostInsertedInbox(now);
      }),
    sweepDue: (now) => {
      const at = now.getTime();
      if (at < sweepAt) return undefined;
      // No second sweep starts while this one runs.
      sweepAt = Number.POSITIVE_INFINITY;
      return sweepSettledInbox({ now, retentionMs }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const finished =
              Exit.isSuccess(exit) && exit.value < INBOX_SWEEP_LIMIT;
            sweepAt = finished ? at + INBOX_SWEEP_INTERVAL_MS : at + pollMs;
          })
        ),
        Effect.asVoid
      );
    },
  };
}

/** What every drain step of a loop or a tick is built from. */
type DrainSettings = {
  /** Builds the action surface for one pass; see `runBody`. */
  actions: () => WorkflowActions;
  entities?: WorkflowEntities | undefined;
  /** How many runs' passes run at once. */
  concurrency: number;
  /**
   * How many deliveries' passes run at once, in a lane beside the runs', so
   * a run never holds a delivery's slot.
   */
  deliveryConcurrency: number;
  /** Defaults to 60 s. */
  leaseMs?: number | undefined;
  /** Defaults to 20 s. */
  heartbeatMs?: number | undefined;
  /** Written on each row this loop or tick leases. Defaults to a fresh id. */
  workerId?: string | undefined;
  /**
   * The clock claims and releases are stamped with. A Wait measures its
   * deadline from the wall clock, so a live loop keeps the default.
   */
  now?: (() => Date) | undefined;
  /**
   * How long a delivered or failed inbox row is kept after it arrived, in
   * milliseconds, before the retention sweep deletes it.
   */
  retentionMs: number;
};

export type WorkerLoopOptions = DrainSettings & {
  /**
   * Aborting it stops the loop claiming. Passes in flight, and a claim still
   * waiting on the database, run to their end, or until `drainMs` has passed.
   */
  signal: AbortSignal;
  /**
   * How long a stopped loop waits for its passes in flight before it
   * interrupts them, and for a claim in flight before it abandons it. Each
   * interrupted pass releases its row due at once, counting no failure.
   * Omitted, it waits for every pass and claim to end.
   */
  drainMs?: number | undefined;
  /** How long the loop sleeps between claims when nothing wakes it sooner. */
  pollMs: number;
  /** Wakes the loop to claim at once, for a producer in the same process. */
  wake?: WorkerWake | undefined;
};

/** What a stopped loop's passes in flight came to. */
export type WorkerLoopOutcome = {
  /** Passes running when the loop stopped that ended within the drain. */
  drained: number;
  /** Passes still running when the drain ran out, interrupted. */
  interrupted: number;
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

function drainOptionsFor(
  settings: DrainSettings
): DrainOptions<ExecutorServices> {
  return {
    bodies: {
      run: runBody({ actions: settings.actions, entities: settings.entities }),
      delivery: deliveryBody(),
    },
    workerId: settings.workerId ?? `worker_${generateId()}`,
    leaseMs: settings.leaseMs ?? DEFAULT_LEASE_MS,
    heartbeatMs: settings.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    now: settings.now ?? (() => new Date()),
  };
}

export type TickOptions = DrainSettings & {
  /**
   * How long the tick may run, in milliseconds. A pass still running when it
   * runs out is interrupted and releases its row due at once, counting no
   * failure, and so is the retention sweep, so the budget stays under the
   * platform's own limit.
   */
  budgetMs: number;
  /**
   * How long after the tick starts it may begin another drain step, in
   * milliseconds, at most `budgetMs`, which is its default. The first drain
   * step always starts. A shorter window leaves a pass claimed late in the
   * tick the difference to finish in before the budget interrupts it part way
   * through a step.
   */
  claimWindowMs?: number | undefined;
};

/** What the passes of one tick came to, by `DrainedPass` kind. */
export type TickOutcome = Record<DrainedPass["kind"], number>;

/** One lane of claims: the schedule kind it claims, and its slots. */
type Lane = { kind: ClaimLane["kind"]; concurrency: number };

/** Deliveries first, so an arrival's pass starts ahead of the runs it may wake. */
function lanesFor(settings: DrainSettings): Lane[] {
  return [
    { kind: "delivery", concurrency: settings.deliveryConcurrency },
    { kind: "run", concurrency: settings.concurrency },
  ];
}

/**
 * Drain steps within a budget, for a host whose platform invokes it, such as
 * a Cron Trigger or a Queue consumer on a Cloudflare Worker. It polls the
 * inbox and starts the retention sweep beside the passes, then repeats a drain
 * step: one claim of up to `deliveryConcurrency` due deliveries and up to
 * `concurrency` due runs, and one pass over each, all of which end before the
 * next claim. It stops claiming once a claim finds nothing due or the claim
 * window has passed, and succeeds once every pass and the sweep have ended or
 * the budget has run out. A row a pass of the tick made due, such as a run an
 * Event's delivery started, is claimed by the next drain step. It sleeps for
 * nothing, so the platform's next invocation is what finds the rows due later.
 */
export function tick(
  options: TickOptions
): Effect.Effect<TickOutcome, never, ExecutorServices> {
  const drain = drainOptionsFor(options);
  const lanes = lanesFor(options).map((lane) => ({
    kind: lane.kind,
    limit: lane.concurrency,
  }));
  return withExecutorLogCategory(
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = drain.now();
        const deadline = new Date(startedAt.getTime() + options.budgetMs);
        const claimUntil =
          startedAt.getTime() +
          Math.min(options.claimWindowMs ?? options.budgetMs, options.budgetMs);
        const upkeep = inboxUpkeep({
          pollMs: 0,
          retentionMs: options.retentionMs,
        });
        yield* upkeep.poll(startedAt);
        const sweep = upkeep.sweepDue(startedAt);
        const sweeping =
          sweep === undefined ? undefined : yield* Effect.forkScoped(sweep);
        const drained: DrainedPass[] = [];
        for (;;) {
          const passes = yield* drainOnce(drain, { lanes, deadline });
          if (passes.length === 0) break;
          const step = yield* Effect.forEach(passes, (pass) =>
            Fiber.join(pass.fiber)
          );
          drained.push(...step);
          if (drain.now().getTime() >= claimUntil) break;
        }
        if (sweeping !== undefined) {
          // Closing the tick's scope interrupts a sweep that outlasts it.
          yield* Fiber.await(sweeping).pipe(
            Effect.timeoutOrElse({
              duration: Math.max(0, deadline.getTime() - drain.now().getTime()),
              orElse: () => Effect.void,
            })
          );
        }
        const counts = countBy(drained, (pass) => pass.kind);
        const outcome: TickOutcome = {
          passed: counts.passed ?? 0,
          failed: counts.failed ?? 0,
          interrupted: counts.interrupted ?? 0,
        };
        return outcome;
      })
    )
  );
}

export function runWorkerLoop(
  options: WorkerLoopOptions
): Effect.Effect<WorkerLoopOutcome, never, ExecutorServices> {
  const { pollMs, signal } = options;
  const drain = drainOptionsFor(options);
  const { now } = drain;
  const upkeep = inboxUpkeep({ pollMs, retentionMs: options.retentionMs });
  // A claim the database never answers would hold a stopped loop forever, so
  // once the stop arrives the claim has the drain to answer.
  const { drainMs } = options;
  const abandon =
    drainMs === undefined
      ? undefined
      : stopRequested(signal).pipe(Effect.andThen(Effect.sleep(drainMs)));

  // When each row a pass of this loop released is next due, by schedule row
  // id. The loop claims at the earliest of these when it comes before the next
  // poll, so a Wait it parked resumes at its deadline. An entry is dropped once
  // its moment has come, and a release with no deadline holds none.
  const releasedWakes = new Map<string, number>();
  // Per lane, how many of its passes are running, and whether its last claim
  // took every free slot, so a due row of its kind may be waiting. A lane's
  // claim takes at most its remaining slots.
  const lanes = lanesFor(options).map((lane) => ({
    ...lane,
    running: 0,
    full: false,
  }));
  type LaneState = (typeof lanes)[number];
  const runningPasses = () => sumBy(lanes, (lane) => lane.running);
  // Completed to cut the loop's current sleep short. Replaced at the top of
  // every iteration, before the claim, so completing it during a claim makes
  // the loop skip its sleep and claim again.
  let wakeLoop = Deferred.makeUnsafe<void>();
  const wakeNow = () => {
    Deferred.doneUnsafe(wakeLoop, Exit.void);
  };

  /**
   * Notes when a row a pass released is due again, waking the loop if that is
   * sooner than anything noted. A row released with no deadline, or deleted,
   * holds no entry.
   */
  const noteRelease = (drained: DrainedPass) => {
    if (drained.kind !== "passed") return;
    const { scheduleId } = drained.claimed;
    const wakeAt =
      "schedule" in drained.result
        ? drained.result.schedule.wakeAt.getTime()
        : undefined;
    if (wakeAt === undefined || wakeAt >= UNDATED_PARK_WAKE_AT.getTime()) {
      releasedWakes.delete(scheduleId);
      return;
    }
    const soonest = earliest(releasedWakes);
    releasedWakes.set(scheduleId, wakeAt);
    if (soonest === undefined || wakeAt < soonest) wakeNow();
  };

  /** Frees a pass's slot in its lane, waking the loop when the lane is full. */
  const freeSlot = (lane: LaneState) => {
    lane.running -= 1;
    if (lane.full) wakeNow();
  };

  const loop = Effect.gen(function* () {
    // Each fiber here waits for one pass and then notes its release and frees
    // its slot, or runs a retention sweep, so the set is empty once every pass
    // and sweep has ended.
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
      for (const [scheduleId, wakeAt] of releasedWakes) {
        if (wakeAt <= claimAt) releasedWakes.delete(scheduleId);
      }

      // A stopped loop abandons a poll the database never answers, as it
      // abandons a claim. The sweep runs beside the lanes, so a long delete
      // holds back no claim, and a stopped loop drains it with its passes.
      yield* raceAbandon(upkeep.poll(new Date(claimAt)), abandon, undefined);
      const sweep = upkeep.sweepDue(new Date(claimAt));
      if (sweep !== undefined) yield* FiberSet.run(settling, sweep);

      // A stop that arrived during the poll ends claiming.
      if (signal.aborted) break;
      const free = new Map(
        lanes.map((lane) => [lane, lane.concurrency - lane.running])
      );
      for (const lane of lanes) lane.full = (free.get(lane) ?? 0) <= 0;
      const claimLanes = lanes.flatMap((lane) => {
        const limit = free.get(lane) ?? 0;
        return limit > 0 ? [{ kind: lane.kind, limit }] : [];
      });
      if (claimLanes.length > 0) {
        const passes = yield* drainOnce(drain, { lanes: claimLanes, abandon });
        const started = countBy(passes, (pass) => pass.claimed.kind);
        for (const lane of lanes) {
          const claimed = started[lane.kind] ?? 0;
          if (claimed === 0) continue;
          lane.running += claimed;
          lane.full = claimed === free.get(lane);
        }
        for (const pass of passes) {
          const lane = lanes.find((each) => each.kind === pass.claimed.kind);
          if (lane === undefined) continue;
          yield* FiberSet.run(
            settling,
            Fiber.await(pass.fiber).pipe(
              Effect.flatMap((exit) =>
                Effect.sync(() => {
                  if (Exit.isSuccess(exit)) noteRelease(exit.value);
                })
              ),
              Effect.ensuring(Effect.sync(() => freeSlot(lane)))
            )
          );
        }
      }

      // Sleep for one poll, or until the soonest released row is due, a pass
      // frees a slot in a full lane, `wake` is called, or the stop signal
      // aborts. The poll finds every other due row, such as one another
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

    // Closing the loop's scope interrupts every pass and sweep still running,
    // so the loop first waits for them to end, for at most `drainMs` when it
    // is set.
    const inFlight = runningPasses();
    const settled = FiberSet.awaitEmpty(settling).pipe(Effect.as(true));
    const drainedAll = yield* drainMs === undefined
      ? settled
      : settled.pipe(
          Effect.timeoutOrElse({
            duration: drainMs,
            orElse: () => Effect.succeed(false),
          })
        );
    const interrupted = drainedAll ? 0 : runningPasses();
    const outcome: WorkerLoopOutcome = {
      drained: inFlight - interrupted,
      interrupted,
    };
    return outcome;
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
