/**
 * The upkeep a worker loop or a tick runs beside its claims: the poll that
 * schedules inbox rows a host inserted itself, and the retention sweeps of the
 * inbox and of run history. Every database failure here is logged and
 * swallowed, so upkeep never stops a loop from claiming.
 */

import { Effect, Exit } from "effect";
import type { RetentionWindows } from "#src/backend/host-retention";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { SWEEP_BATCH } from "#src/backend/services/executions/repo/retention-policy";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";

/** How many host-inserted inbox rows one poll schedules at most. */
const INBOX_POLL_LIMIT = 100;

/** How often the retention sweeps run when the last ones finished. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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

/** What one sweep step came to. */
type SweepStep = {
  /** How many rows the step deleted. */
  swept: number;
  /** Whether the step deleted less than a full batch, or failed. */
  finished: boolean;
};

/**
 * One batch of one sweep: deletes up to `SWEEP_BATCH` rows past `olderThan`
 * through `sweep`. A step the database fails is logged with `failure` and
 * counts as finished with nothing deleted, so the next try waits for the
 * hourly sweep.
 */
function sweepStep(input: {
  sweep: (batch: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
  olderThan: Date;
  failure: string;
}): Effect.Effect<SweepStep> {
  return input.sweep({ olderThan: input.olderThan, limit: SWEEP_BATCH }).pipe(
    Effect.map((swept) => ({ swept, finished: swept < SWEEP_BATCH })),
    Effect.catchTag("DatabaseError", (error) =>
      Effect.logError(input.failure).pipe(
        Effect.annotateLogs({ error }),
        Effect.as({ swept: 0, finished: true })
      )
    )
  );
}

/** The instant `retentionMs` before `now`, which a sweep deletes rows older than. */
function cutoff(now: Date, retentionMs: number): Date {
  return new Date(now.getTime() - retentionMs);
}

/**
 * The inbox's retention sweep: deletes delivered or failed inbox rows that
 * arrived more than `retentionMs` before `now`, as
 * `ExecutionRepo.sweepSettledInbox` describes, and answers whether it
 * finished. A `pending` row is never deleted.
 */
const sweepSettledInbox = Effect.fn("wfgraph.executor.sweep_inbox")(
  function* (input: { now: Date; retentionMs: number }) {
    const olderThan = cutoff(input.now, input.retentionMs);
    yield* Effect.annotateCurrentSpan({
      "wfgraph.executor.limit": SWEEP_BATCH,
      "wfgraph.executor.retention_ms": input.retentionMs,
      "wfgraph.executor.cutoff": olderThan.toISOString(),
    });
    const executions = yield* ExecutionRepo;
    const step = yield* sweepStep({
      sweep: executions.sweepSettledInbox,
      olderThan,
      failure:
        "Could not delete the settled inbox rows past the retention window",
    });
    yield* Effect.annotateCurrentSpan("wfgraph.executor.swept", step.swept);
    if (step.swept > 0) {
      yield* Effect.logInfo(
        "Deleted settled inbox rows past the retention window"
      ).pipe(
        Effect.annotateLogs({
          inbox: { swept: step.swept, retentionMs: input.retentionMs },
        })
      );
    }
    return step.finished;
  }
);

/**
 * The run-history retention sweep, one batch of each kind, and whether all
 * three finished: ended Executions completed more than `retentionMs` before
 * `now` (`ExecutionRepo.sweepEndedExecutions` says what each takes with it and
 * what it keeps), then workflow audit rows (`sweepWorkflowAuditEvents`), then
 * draft snapshots (`WorkflowRepo.sweepUnreferencedDraftSnapshots`). The
 * snapshots go after the Executions so a snapshot this sweep's run deletions
 * free is collected now, and not one sweep later.
 */
const sweepRunHistory = Effect.fn("wfgraph.executor.sweep_runs")(
  function* (input: { now: Date; retentionMs: number }) {
    const olderThan = cutoff(input.now, input.retentionMs);
    yield* Effect.annotateCurrentSpan({
      "wfgraph.executor.limit": SWEEP_BATCH,
      "wfgraph.executor.retention_ms": input.retentionMs,
      "wfgraph.executor.cutoff": olderThan.toISOString(),
    });
    const executions = yield* ExecutionRepo;
    const workflows = yield* WorkflowRepo;
    const runs = yield* sweepStep({
      sweep: executions.sweepEndedExecutions,
      olderThan,
      failure: "Could not delete the ended runs past the run retention window",
    });
    const audit = yield* sweepStep({
      sweep: executions.sweepWorkflowAuditEvents,
      olderThan,
      failure:
        "Could not delete the workflow audit rows past the run retention window",
    });
    const snapshots = yield* sweepStep({
      sweep: workflows.sweepUnreferencedDraftSnapshots,
      olderThan,
      failure:
        "Could not delete the unused draft snapshots past the run retention window",
    });
    const swept = {
      executions: runs.swept,
      auditEvents: audit.swept,
      draftSnapshots: snapshots.swept,
    };
    yield* Effect.annotateCurrentSpan({
      "wfgraph.executor.swept.executions": swept.executions,
      "wfgraph.executor.swept.auditEvents": swept.auditEvents,
      "wfgraph.executor.swept.draftSnapshots": swept.draftSnapshots,
    });
    if (swept.executions + swept.auditEvents + swept.draftSnapshots > 0) {
      yield* Effect.logInfo(
        "Deleted run history past the retention window"
      ).pipe(
        Effect.annotateLogs({
          runs: { ...swept, retentionMs: input.retentionMs },
        })
      );
    }
    return runs.finished && audit.finished && snapshots.finished;
  }
);

/**
 * The upkeep of the executor's tables for one worker loop or one tick: the
 * event inbox's poll, and the retention sweeps of the inbox and of run
 * history. It keeps its own timing so its caller can ask for both on every
 * iteration.
 */
export type ExecutorUpkeep = {
  /**
   * Schedules the inbox rows a host inserted itself, when `pollMs` has passed
   * since the last poll, and otherwise does nothing.
   */
  readonly poll: (now: Date) => Effect.Effect<void, never, ExecutionRepo>;
  /**
   * The retention sweeps due at `now`, for the caller to run or fork, or
   * undefined while they are running or none is due: the inbox's, then the
   * run history's when the upkeep has a run window. They run once an hour,
   * and one poll interval after a run in which any sweep deleted a full
   * batch or the sweeps were interrupted. A sweep the database fails is
   * logged and counts as finished, so during an outage the next try comes an
   * hour later, and not every poll interval.
   */
  readonly sweepDue: (
    now: Date
  ) => Effect.Effect<void, never, ExecutionRepo | WorkflowRepo> | undefined;
};

/**
 * The upkeep of one loop or tick. A new upkeep polls and sweeps at its first
 * call, so a tick, which builds one per invocation, polls and sweeps every
 * time it runs. Without `retention.runMs`, run history is never swept.
 */
export function executorUpkeep(input: {
  pollMs: number;
  retention: RetentionWindows;
}): ExecutorUpkeep {
  const { pollMs, retention } = input;
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
      const sweeps = Effect.gen(function* () {
        const inbox = yield* sweepSettledInbox({
          now,
          retentionMs: retention.inboxMs,
        });
        if (retention.runMs === undefined) return inbox;
        const runs = yield* sweepRunHistory({
          now,
          retentionMs: retention.runMs,
        });
        return inbox && runs;
      });
      return sweeps.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const finished = Exit.isSuccess(exit) && exit.value;
            sweepAt = finished ? at + SWEEP_INTERVAL_MS : at + pollMs;
          })
        ),
        Effect.asVoid
      );
    },
  };
}
