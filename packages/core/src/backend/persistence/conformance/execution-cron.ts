/**
 * Cron schedule timers: the rows Publish, pause and resume write, and the fire
 * that opens a scheduled run and moves its timer on in one transaction fenced
 * on the timer's lease. Each case checks a rule of the `Cron` model in
 * `.claude/skills/verify-durable-executor`, named in its title. Every write
 * passes its own clock, so each expected slot is fixed after `T0` (09:00 UTC).
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  type CronSchedule,
  latestSlotAtOrBefore,
} from "@wfgraph/shared/lifecycle/cron-schedule";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  type CronFence,
  type CronPublication,
  type CronRefusedEntry,
  ExecutionRepo,
  type FireCronTimerInput,
} from "#src/backend/services/executions/repo";
import { cronWakeAfter } from "#src/backend/services/executions/repo/cron-policy";
import { workflowEntityValue } from "@wfgraph/shared/lifecycle/execution-contracts";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  type CaseDatabase,
  type ConformanceConnection,
  emptyGraph,
  notYetDue,
  type PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  at,
  cronTimers,
  leaseScheduleRow,
} from "#src/backend/persistence/conformance/schedule-support";

const WORKFLOW_ID = "wf_cron";

/** Every five minutes, in UTC. */
const EVERY_FIVE: CronSchedule = { cron: "*/5 * * * *", timeZone: "UTC" };
/** At the top of every hour, in UTC. */
const HOURLY: CronSchedule = { cron: "0 * * * *", timeZone: "UTC" };
/** `HOURLY`'s expression read in another zone: an edit of that schedule. */
const HOURLY_IN_KOLKATA: CronSchedule = {
  cron: "0 * * * *",
  timeZone: "Asia/Kolkata",
};
/** Every ten minutes, in UTC. */
const EVERY_TEN: CronSchedule = { cron: "*/10 * * * *", timeZone: "UTC" };

function minutes(count: number): number {
  return count * 60_000;
}

/** A published graph whose entry node declares `schedules`. */
function scheduledGraph(
  schedules: readonly CronSchedule[],
  concurrency: Concurrency
) {
  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: "entry",
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          type: "lifecycle",
          label: "Lifecycle",
          config: {
            lifecycleRules: {
              startEvents: [],
              cancelEvents: [],
              concurrency,
              schedules: [...schedules],
            },
          },
        },
      },
    ],
    edges: [],
  });
}

/** Stores the workflow `WORKFLOW_ID`, unpublished. */
const insertWorkflow = Effect.gen(function* () {
  const workflows = yield* WorkflowRepo;
  yield* workflows.insert({
    id: WORKFLOW_ID,
    name: "Nightly report",
    graph: emptyGraph,
    eventSubscriptions: [],
  });
});

/** Publishes version `version` of `WORKFLOW_ID`, declaring `schedules`, at `now`. */
function publish(input: {
  version: number;
  schedules: readonly CronSchedule[];
  now: Date;
  concurrency?: Concurrency | undefined;
}) {
  return Effect.gen(function* () {
    const workflows = yield* WorkflowRepo;
    const current = yield* workflows.findByIdWithPublishedVersion(WORKFLOW_ID);
    const graph = scheduledGraph(
      input.schedules,
      input.concurrency ?? "unlimited"
    );
    const published = yield* workflows.insertPublishedVersion({
      workflowId: WORKFLOW_ID,
      versionId: `ver_${input.version}`,
      version: input.version,
      expectedPublishedVersionId: current?.workflow.publishedVersionId ?? null,
      expectedDraftRevision: current?.workflow.draftRevision ?? 1,
      graph,
      draftGraph: graph,
      catalogFingerprint: "catalog",
      graphDigest: `digest-${input.version}`,
      eventSubscriptions: [],
      now: input.now,
    });
    if (!published || !("version" in published)) {
      throw new Error("The publish was refused");
    }
  });
}

/** The workflow's timers, earliest `wake_at` first. */
function timers(database: CaseDatabase) {
  return cronTimers(database, WORKFLOW_ID);
}

/** The id of the timer of `schedule`, which the case expects to exist. */
function timerId(database: CaseDatabase, schedule: CronSchedule) {
  return Effect.map(timers(database), (rows) => {
    const row = rows.find(
      (timer) =>
        timer.cron === schedule.cron && timer.timeZone === schedule.timeZone
    );
    if (!row) throw new Error("The schedule has no timer");
    return row.id;
  });
}

/**
 * Leases the timer `scheduleId` under `ownerToken`, standing in for a claim,
 * and answers the fence a pass holding that lease carries.
 */
async function leaseTimer(
  database: CaseDatabase,
  scheduleId: string,
  ownerToken: string
): Promise<CronFence> {
  await leaseScheduleRow(database, scheduleId, ownerToken);
  return { kind: "cron", scheduleId, workflowId: WORKFLOW_ID, ownerToken };
}

/**
 * The slot a pass whose clock reads `now` fires, and the wake it moves the
 * timer to, as the cron pass computes them before it writes.
 */
function slotTimes(schedule: CronSchedule, now: Date) {
  const slot = latestSlotAtOrBefore(schedule, now);
  if (slot === undefined) throw new Error("The schedule has no slot by now");
  return { slot, nextWakeAt: cronWakeAfter(schedule, now) };
}

/**
 * A Refused Start for `reason` that names the slot it was written for, so a
 * case reads which slot was written.
 */
function refusedEntry(reason: string, slot: Date): CronRefusedEntry {
  return {
    message: `Refused the ${slot.toISOString()} scheduled run`,
    metadata: { reason },
  };
}

/**
 * A skip of the slot `schedule` runs at `now` under `fence`, as the cron
 * pass makes it, against `expected` when the preflight checked one.
 */
function skip(input: {
  fence: CronFence;
  schedule: CronSchedule;
  now: Date;
  expected?: CronPublication | undefined;
  error: string;
}) {
  const { slot, nextWakeAt } = slotTimes(input.schedule, input.now);
  return Effect.flatMap(ExecutionRepo, (executions) =>
    executions.fencedCron(input.fence).skipCronSlot({
      expected: input.expected,
      nextWakeAt,
      error: input.error,
      refusedEntry: refusedEntry("published_version_not_runnable", slot),
    })
  );
}

/** Every Refused Start of the workflow, newest first. */
const refusals = Effect.gen(function* () {
  const executions = yield* ExecutionRepo;
  return yield* executions.listWorkflowEvents({
    workflowId: WORKFLOW_ID,
    eventType: "run_refused",
  });
});

/** A fire of `schedule` under `fence`, as the cron pass makes it. */
function fire(input: {
  fence: CronFence;
  schedule: CronSchedule;
  now: Date;
  versionId?: string | undefined;
  schedules?: readonly CronSchedule[] | undefined;
  concurrency?: Concurrency | undefined;
}) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const versionId = input.versionId ?? "ver_1";
    const { slot, nextWakeAt } = slotTimes(input.schedule, input.now);
    const request: FireCronTimerInput = {
      schedule: input.schedule,
      expected: {
        versionId,
        mode: "live",
        schedules: input.schedules ?? [input.schedule],
      },
      start: {
        execution: {
          workflowId: WORKFLOW_ID,
          workflowVersionId: versionId,
          startSource: "schedule",
          runMode: "live",
          entityValue: workflowEntityValue(WORKFLOW_ID),
          input: {},
        },
        concurrency: input.concurrency ?? "unlimited",
        supersededReason: "Superseded by a newer start",
        startedEntry: notYetDue.startedEntry,
      },
      slot,
      nextWakeAt,
      refusedEntry: refusedEntry("concurrency_first_wins", slot),
      now: input.now,
    };
    return yield* executions.fencedCron(input.fence).fireCronTimer(request);
  });
}

/** Every run of the workflow, superseded ones included. */
const runs = Effect.gen(function* () {
  const executions = yield* ExecutionRepo;
  return yield* executions.listByWorkflow({
    workflowId: WORKFLOW_ID,
    includeSuperseded: true,
  });
});

/** A connection on a fresh database with `WORKFLOW_ID` stored, unpublished. */
async function withWorkflow(
  openDatabase: () => Promise<CaseDatabase>
): Promise<{ database: CaseDatabase; connection: ConformanceConnection }> {
  const database = await openDatabase();
  const connection = await database.open();
  await connection.run(insertWorkflow);
  return { database, connection };
}

export function describeExecutionCronConformance({
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("cron schedule timers", () => {
    it("writes no timer before the first Publish, then one per schedule due at its first slot after the Publish (TimersMatchThePublishedSchedules, NoFireBeforeTheTimerStarted)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const result = await connection.run(
        Effect.gen(function* () {
          const unpublished = yield* timers(database);
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE, HOURLY],
            now: at(minutes(5)),
          });
          return { unpublished, published: yield* timers(database) };
        })
      );

      expect(result.unpublished).toEqual([]);
      // 09:05 is the publish itself, so the first slot is strictly after it.
      expect(result.published).toEqual([
        expect.objectContaining({
          kind: "cron",
          workflowId: WORKFLOW_ID,
          ...EVERY_FIVE,
          state: "waiting",
          wakeAt: at(minutes(10)),
          ownerToken: null,
          executionId: null,
          inboxId: null,
        }),
        expect.objectContaining({
          ...HOURLY,
          state: "waiting",
          wakeAt: at(minutes(60)),
          ownerToken: null,
        }),
      ]);
    });

    it("keeps an unchanged schedule's timer at Publish, lease and all, and replaces an edited one and deletes a removed one (Republished, EditClearsTheLease, RemovedTimerIsDeleted)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const ids = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE, HOURLY, EVERY_TEN],
            now: at(minutes(1)),
          });
          return {
            kept: yield* timerId(database, EVERY_FIVE),
            edited: yield* timerId(database, HOURLY),
          };
        })
      );
      await leaseTimer(database, ids.kept, "tok_kept");
      const editedFence = await leaseTimer(database, ids.edited, "tok_edited");

      const result = await connection.run(
        Effect.gen(function* () {
          // HOURLY moves to another zone and EVERY_TEN is removed.
          yield* publish({
            version: 2,
            schedules: [EVERY_FIVE, HOURLY_IN_KOLKATA],
            now: at(minutes(2)),
          });
          const after = yield* timers(database);
          const editedFire = yield* Effect.flip(
            fire({
              fence: editedFence,
              schedule: HOURLY,
              now: at(minutes(60)),
              versionId: "ver_2",
            })
          );
          return { after, editedFire: editedFire._tag };
        })
      );

      expect(result.after).toEqual([
        expect.objectContaining({
          id: ids.kept,
          ...EVERY_FIVE,
          state: "leased",
          ownerToken: "tok_kept",
          wakeAt: at(minutes(5)),
        }),
        expect.objectContaining({
          ...HOURLY_IN_KOLKATA,
          state: "waiting",
          ownerToken: null,
          // Asia/Kolkata is UTC+5:30, so its top of the hour is :30 in UTC.
          wakeAt: at(minutes(30)),
        }),
      ]);
      expect(result.after.map((timer) => timer.id)).not.toContain(ids.edited);
      expect(result.editedFire).toBe("LeaseLost");
    });

    it("claims a timer in the cron lane alone, once it is due, and fires it under the claim's fence (ClaimWhenDue)", async () => {
      const { connection } = await withWorkflow(openDatabase);
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          const claim = (kind: "run" | "cron", now: Date) =>
            executions.claimDue({
              lanes: [{ kind, limit: 10 }],
              workerId: "worker_1",
              leaseMs: 60_000,
              now,
            });
          const early = yield* claim("cron", at(minutes(4)));
          const runLane = yield* claim("run", at(minutes(5)));
          const [claimed] = yield* claim("cron", at(minutes(5)));
          if (claimed?.kind !== "cron") throw new Error("No timer claimed");
          const fired = yield* fire({
            fence: {
              kind: "cron",
              scheduleId: claimed.scheduleId,
              workflowId: claimed.workflowId,
              ownerToken: claimed.ownerToken,
            },
            schedule: claimed.schedule,
            now: at(minutes(5)),
          });
          return { early, runLane, claimed, fired };
        })
      );

      expect(result.early).toEqual([]);
      expect(result.runLane).toEqual([]);
      expect(result.claimed).toMatchObject({
        kind: "cron",
        workflowId: WORKFLOW_ID,
        schedule: EVERY_FIVE,
        attempt: 0,
      });
      expect(result.fired).toMatchObject({
        kind: "fired",
        start: { execution: { scheduledFor: at(minutes(5)) } },
      });
    });

    it("fires each slot once: opens one run for the slot, records it as scheduled_for, and moves the timer past now with its lease released (OneFirePerSlot, FireAndAdvanceTogether)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const fired = yield* fire({
            fence,
            schedule: EVERY_FIVE,
            now: at(minutes(5) + 30_000),
          });
          const again = yield* Effect.flip(
            fire({ fence, schedule: EVERY_FIVE, now: at(minutes(6)) })
          );
          return {
            fired,
            again: again._tag,
            timers: yield* timers(database),
            runs: yield* runs,
            summary:
              fired.kind === "fired" && fired.start.status === "started"
                ? yield* executions.findSummaryById(fired.start.execution.id)
                : null,
          };
        })
      );

      expect(result.fired).toMatchObject({
        kind: "fired",
        start: {
          status: "started",
          execution: {
            workflowId: WORKFLOW_ID,
            workflowVersionId: "ver_1",
            startSource: "schedule",
            entityValue: workflowEntityValue(WORKFLOW_ID),
            scheduledFor: at(minutes(5)),
            status: "running",
          },
        },
      });
      expect(result.again).toBe("LeaseLost");
      expect(result.timers).toEqual([
        expect.objectContaining({
          id: scheduleId,
          state: "waiting",
          wakeAt: at(minutes(10)),
          ownerToken: null,
          leaseExpiresAt: null,
          attempt: 0,
        }),
      ]);
      // Both readers the Runs view polls carry the slot and the schedule.
      const scheduled = {
        scheduledFor: at(minutes(5)),
        scheduleCron: EVERY_FIVE.cron,
        scheduleTimeZone: EVERY_FIVE.timeZone,
      };
      expect(result.runs).toEqual([expect.objectContaining(scheduled)]);
      expect(result.summary).toMatchObject(scheduled);
    });

    it("holds a run's three schedule columns to all or none, and to a scheduled run alone", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");
      const fired = await connection.run(
        fire({ fence, schedule: EVERY_FIVE, now: at(minutes(5)) })
      );
      if (fired.kind !== "fired" || fired.start.status !== "started") {
        throw new Error("The fire opened no run");
      }
      const run = `id = '${fired.start.execution.id}'`;

      await expect(
        database.execute(
          `update workflow_executions set schedule_time_zone = null where ${run}`
        )
      ).rejects.toThrow();
      // The slot without the schedule, and the schedule without the slot.
      await expect(
        database.execute(
          `update workflow_executions set schedule_cron = null, schedule_time_zone = null where ${run}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_executions set scheduled_for = null where ${run}`
        )
      ).rejects.toThrow();
      await expect(
        database.execute(
          `update workflow_executions set start_source = 'manual' where ${run}`
        )
      ).rejects.toThrow();
      // Clearing all three is allowed, which is the shape of every other run.
      await expect(
        database.execute(
          `update workflow_executions set scheduled_for = null, schedule_cron = null, schedule_time_zone = null where ${run}`
        )
      ).resolves.toBeUndefined();
    });

    it("writes nothing from a pass whose lease another claim took over (NoFireWithoutTheLease)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const stale = await leaseTimer(database, scheduleId, "tok_stale");
      await leaseTimer(database, scheduleId, "tok_live");

      const result = await connection.run(
        Effect.gen(function* () {
          const fired = yield* Effect.flip(
            fire({ fence: stale, schedule: EVERY_FIVE, now: at(minutes(5)) })
          );
          const skipped = yield* Effect.flip(
            skip({
              fence: stale,
              schedule: EVERY_FIVE,
              error: "skipped",
              now: at(minutes(5)),
            })
          );
          return {
            fired: fired._tag,
            skipped: skipped._tag,
            timers: yield* timers(database),
            runs: yield* runs,
            refusals: yield* refusals,
          };
        })
      );

      expect(result.fired).toBe("LeaseLost");
      expect(result.skipped).toBe("LeaseLost");
      expect(result.refusals).toEqual([]);
      expect(result.timers).toEqual([
        expect.objectContaining({
          state: "leased",
          ownerToken: "tok_live",
          wakeAt: at(minutes(5)),
          lastError: null,
        }),
      ]);
      expect(result.runs).toEqual([]);
    });

    it("fires a late claim once, for the latest slot at or before the fire (FireRunsTheLatestSlot)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          // Due at 09:05 and fired at 09:27, so 09:05 through 09:25 were missed.
          const fired = yield* fire({
            fence,
            schedule: EVERY_FIVE,
            now: at(minutes(27)),
          });
          return { fired, runs: yield* runs };
        })
      );

      expect(result.fired).toMatchObject({
        kind: "fired",
        start: { execution: { scheduledFor: at(minutes(25)) } },
      });
      expect(result.runs).toHaveLength(1);
    });

    it("deletes the timers when the workflow pauses, and writes them from the resume time when it resumes (PauseDeletesTimers, Resume, NoFireWhilePaused)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE, HOURLY],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.setPaused({
            workflowId: WORKFLOW_ID,
            isPaused: true,
            now: at(minutes(2)),
          });
          const paused = yield* timers(database);
          const firedWhilePaused = yield* Effect.flip(
            fire({ fence, schedule: EVERY_FIVE, now: at(minutes(5)) })
          );
          // A Publish while paused writes no timers either.
          yield* publish({
            version: 2,
            schedules: [EVERY_FIVE, HOURLY],
            now: at(minutes(3)),
          });
          const publishedWhilePaused = yield* timers(database);
          yield* workflows.setPaused({
            workflowId: WORKFLOW_ID,
            isPaused: false,
            now: at(minutes(31)),
          });
          return {
            paused,
            firedWhilePaused: firedWhilePaused._tag,
            publishedWhilePaused,
            resumed: yield* timers(database),
            runs: yield* runs,
          };
        })
      );

      expect(result.paused).toEqual([]);
      expect(result.firedWhilePaused).toBe("LeaseLost");
      expect(result.publishedWhilePaused).toEqual([]);
      // Resumed at 09:31, so the 09:05 through 09:30 slots the pause skipped
      // are not fired.
      expect(result.resumed).toEqual([
        expect.objectContaining({
          ...EVERY_FIVE,
          state: "waiting",
          wakeAt: at(minutes(35)),
          ownerToken: null,
        }),
        expect.objectContaining({
          ...HOURLY,
          state: "waiting",
          wakeAt: at(minutes(60)),
          ownerToken: null,
        }),
      ]);
      expect(result.runs).toEqual([]);
    });

    it("opens the run on the version published when the fire commits, and fires nothing against a version the caller did not check (FireRunsThePublishedVersion)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          // Republished while the pass holds the lease: the timer and its
          // lease stay, and the pass's preflight checked ver_1.
          yield* publish({
            version: 2,
            schedules: [EVERY_FIVE],
            now: at(minutes(3)),
          });
          const stale = yield* fire({
            fence,
            schedule: EVERY_FIVE,
            now: at(minutes(5)),
            versionId: "ver_1",
          });
          const afterStale = {
            timers: yield* timers(database),
            runs: yield* runs,
          };
          const fired = yield* fire({
            fence,
            schedule: EVERY_FIVE,
            now: at(minutes(5)),
            versionId: "ver_2",
          });
          return { stale, afterStale, fired };
        })
      );

      expect(result.stale).toEqual({ kind: "stale" });
      expect(result.afterStale.runs).toEqual([]);
      expect(result.afterStale.timers).toEqual([
        expect.objectContaining({ state: "leased", ownerToken: "tok_1" }),
      ]);
      expect(result.fired).toMatchObject({
        kind: "fired",
        start: { execution: { workflowVersionId: "ver_2" } },
      });
    });

    it("writes a Refused Start under first-wins while a scheduled run is going, and still moves the timer on (RefusedStart, RefusalStillAdvances)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
            concurrency: "first-wins",
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const first = await leaseTimer(database, scheduleId, "tok_1");
      const opened = await connection.run(
        fire({
          fence: first,
          schedule: EVERY_FIVE,
          now: at(minutes(5)),
          concurrency: "first-wins",
        })
      );
      const second = await leaseTimer(database, scheduleId, "tok_2");

      const result = await connection.run(
        Effect.gen(function* () {
          const refused = yield* fire({
            fence: second,
            schedule: EVERY_FIVE,
            now: at(minutes(10)),
            concurrency: "first-wins",
          });
          return {
            refused,
            refusals: yield* refusals,
            timers: yield* timers(database),
            runs: yield* runs,
          };
        })
      );

      if (opened.kind !== "fired" || opened.start.status !== "started") {
        throw new Error("The first fire opened no run");
      }
      const firstRunId = opened.start.execution.id;
      expect(result.refused).toMatchObject({
        kind: "fired",
        start: { status: "refused", inFlightExecutionIds: [firstRunId] },
      });
      expect(result.refusals).toEqual([
        expect.objectContaining({
          message: `Refused the ${at(minutes(10)).toISOString()} scheduled run`,
          metadata: {
            reason: "concurrency_first_wins",
            inFlightExecutionIds: [firstRunId],
          },
        }),
      ]);
      expect(result.timers).toEqual([
        expect.objectContaining({
          state: "waiting",
          wakeAt: at(minutes(15)),
          ownerToken: null,
        }),
      ]);
      expect(result.runs.map((run) => run.id)).toEqual([firstRunId]);
    });

    it("supersedes the scheduled run still going under newest-wins (OneLiveScheduledRun)", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
            concurrency: "newest-wins",
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const first = await leaseTimer(database, scheduleId, "tok_1");
      const opened = await connection.run(
        fire({
          fence: first,
          schedule: EVERY_FIVE,
          now: at(minutes(5)),
          concurrency: "newest-wins",
        })
      );
      const second = await leaseTimer(database, scheduleId, "tok_2");

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const newer = yield* fire({
            fence: second,
            schedule: EVERY_FIVE,
            now: at(minutes(10)),
            concurrency: "newest-wins",
          });
          if (opened.kind !== "fired" || opened.start.status !== "started") {
            throw new Error("The first fire opened no run");
          }
          const firstRunId = opened.start.execution.id;
          return {
            firstRunId,
            newer,
            firstStatus: yield* executions.findStatusById(firstRunId),
            firstSchedule: yield* executions.findSchedule({
              executionId: firstRunId,
            }),
            firstSuperseded: (yield* executions.listEvents(firstRunId))
              .filter((event) => event.eventType === "run_superseded")
              .map(({ message, metadata }) => ({ message, metadata })),
          };
        })
      );

      expect(result.newer).toMatchObject({
        kind: "fired",
        start: {
          status: "started",
          supersededExecutionIds: [result.firstRunId],
          execution: { scheduledFor: at(minutes(10)) },
        },
      });
      expect(result.firstStatus?.status).toBe("superseded");
      expect(result.firstSchedule).toBeNull();
      expect(result.firstSuperseded).toEqual([
        { message: "Superseded by a newer start", metadata: {} },
      ]);
    });

    it("deletes a timer whose schedule the published version no longer declares, and fires nothing", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          const dropped = yield* fire({
            fence,
            schedule: EVERY_FIVE,
            now: at(minutes(5)),
            schedules: [],
          });
          return {
            dropped,
            timers: yield* timers(database),
            runs: yield* runs,
          };
        })
      );

      expect(result.dropped).toEqual({
        kind: "dropped",
        reason: "schedule_unpublished",
      });
      expect(result.timers).toEqual([]);
      expect(result.runs).toEqual([]);
    });

    it("skips a slot without firing: writes a Refused Start for the slot, moves the timer past now, releases its lease and records why", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          const skipped = yield* skip({
            fence,
            schedule: EVERY_FIVE,
            expected: { versionId: "ver_1", mode: "live" },
            error: "The workflow's graph will not run",
            now: at(minutes(6)),
          });
          return {
            skipped,
            timers: yield* timers(database),
            runs: yield* runs,
            refusals: yield* refusals,
          };
        })
      );

      // 09:05 is the latest slot at or before the skip at 09:06.
      expect(result.skipped).toEqual({ kind: "skipped" });
      expect(result.refusals).toEqual([
        expect.objectContaining({
          workflowId: WORKFLOW_ID,
          executionId: null,
          eventType: "run_refused",
          message: `Refused the ${at(minutes(5)).toISOString()} scheduled run`,
          metadata: { reason: "published_version_not_runnable" },
        }),
      ]);
      expect(result.timers).toEqual([
        expect.objectContaining({
          state: "waiting",
          wakeAt: at(minutes(10)),
          ownerToken: null,
          lastError: "The workflow's graph will not run",
        }),
      ]);
      expect(result.runs).toEqual([]);
    });

    it("skips nothing against a version a Publish replaced since the preflight, so the slot can still fire", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE],
            now: at(minutes(1)),
          });
          return yield* timerId(database, EVERY_FIVE);
        })
      );
      const fence = await leaseTimer(database, scheduleId, "tok_1");

      const result = await connection.run(
        Effect.gen(function* () {
          // The Publish keeps the unchanged schedule's timer, lease and all.
          yield* publish({
            version: 2,
            schedules: [EVERY_FIVE],
            now: at(minutes(2)),
          });
          const skipped = yield* skip({
            fence,
            schedule: EVERY_FIVE,
            expected: { versionId: "ver_1", mode: "live" },
            error: "The workflow's graph will not run",
            now: at(minutes(6)),
          });
          return {
            skipped,
            timers: yield* timers(database),
            refusals: yield* refusals,
          };
        })
      );

      expect(result.skipped).toEqual({ kind: "stale" });
      expect(result.refusals).toEqual([]);
      expect(result.timers).toEqual([
        expect.objectContaining({
          id: scheduleId,
          state: "leased",
          ownerToken: "tok_1",
          lastError: null,
        }),
      ]);
    });

    it("deletes a workflow's timers with the workflow", async () => {
      const { database, connection } = await withWorkflow(openDatabase);
      const result = await connection.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* publish({
            version: 1,
            schedules: [EVERY_FIVE, HOURLY],
            now: at(minutes(1)),
          });
          const before = yield* timers(database);
          yield* workflows.deleteById(WORKFLOW_ID);
          return { before, after: yield* timers(database) };
        })
      );

      expect(result.before).toHaveLength(2);
      expect(result.after).toEqual([]);
    });
  });
}
