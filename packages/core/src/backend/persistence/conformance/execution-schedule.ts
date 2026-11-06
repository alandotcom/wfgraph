/**
 * The executions aggregate's schedule rows and step memo, which the database
 * executor runs on: what a claim leases, what a release writes back, how a
 * step's failures are counted, and what a terminal write leaves behind.
 *
 * Every case passes its own clock to the claim and the release, so the due and
 * lease comparisons do not depend on how fast the case runs.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  ExecutionRepo,
  type ParkWake,
  type PassOutcome,
} from "#src/backend/services/executions/repo";
import { LEASE_EXPIRED_ERROR } from "#src/backend/services/executions/repo/release-policy";
import {
  type PersistenceTestRegistry,
  notYetDue,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  LEASE_MS,
  at,
  scheduledRun,
  openRun,
  claimRun,
  park,
  claimOne,
  seeded,
} from "#src/backend/persistence/conformance/schedule-support";

/** A re-park of one wait row as a delay Wait due two minutes after `T0`. */
function reparkInput(waitStateId: string) {
  return {
    waitStateId,
    workflowVersionId: "ver_1",
    side: "started" as const,
    waitType: "delay" as const,
    waitUntil: at(120_000),
    subscribedEvents: [],
    resumeToken: null,
    metadata: {},
  };
}

export function describeExecutionScheduleConformance({
  openConnection,
  openDatabase,
}: PersistenceTestRegistry): void {
  describe("execution schedule and step memo", () => {
    it("claims due rows oldest first and never leases one row to two claimers", async () => {
      const database = await openDatabase();
      const first = await seeded(await database.open());
      const second = await database.open();

      const ids = await first.run(
        Effect.gen(function* () {
          return {
            late: yield* scheduledRun(at(2_000)),
            early: yield* scheduledRun(at(1_000)),
            future: yield* scheduledRun(at(60_000)),
          };
        })
      );

      const [fromFirst, fromSecond] = await Promise.all([
        claimOne(first, "worker_a"),
        claimOne(second, "worker_b"),
      ]);
      const leased = [...fromFirst, ...fromSecond].flatMap((row) =>
        row.kind === "run" ? [row.executionId] : []
      );

      // Each claimer leased one row, the two rows due by then, and neither
      // took the row due later.
      expect(fromFirst).toHaveLength(1);
      expect(fromSecond).toHaveLength(1);
      expect(leased.toSorted()).toEqual([ids.early, ids.late].toSorted());

      const sequential = await first.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* scheduledRun(at(3_000));
          const fresh = yield* scheduledRun(at(1_500));
          const claimed = yield* executions.claimDue({
            kind: "run",
            workerId: "worker_a",
            limit: 1,
            leaseMs: LEASE_MS,
            now: at(5_000),
          });
          return {
            fresh,
            claimed: claimed.map((row) =>
              row.kind === "run" ? row.executionId : null
            ),
          };
        })
      );
      expect(sequential.claimed).toEqual([sequential.fresh]);
    });

    it("leases with a fresh token, and counts a run failure only for a lease that expired with no step running", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { claim: first, fence: staleFence } = yield* claimRun(
            executionId,
            T0
          );
          const beforeExpiry = yield* executions.claimDue({
            kind: "run",
            workerId: "worker_2",
            limit: 10,
            leaseMs: LEASE_MS,
            now: at(LEASE_MS - 1),
          });
          const { claim: second } = yield* claimRun(
            executionId,
            at(LEASE_MS + 1)
          );
          const staleWrite = yield* Effect.flip(
            executions.fenced(staleFence).writeStepMemo({
              stepId: "step_1",
              value: "stale",
              leaseExpiresAt: at(LEASE_MS * 3),
            })
          );
          return {
            first,
            beforeExpiry,
            second,
            staleWrite,
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      expect(result.first.attempt).toBe(0);
      expect(result.first.leaseExpiresAt).toEqual(at(LEASE_MS));
      expect(result.beforeExpiry).toEqual([]);
      expect(result.second.attempt).toBe(1);
      expect(result.second.ownerToken).not.toBe(result.first.ownerToken);
      expect(result.second.scheduleId).toBe(result.first.scheduleId);
      expect(result.staleWrite._tag).toBe("LeaseLost");
      expect(result.memo).toEqual([]);
    });

    it("resolves a parked run's overdue park as a timeout when the claim takes it", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const overdue = yield* park(executionId, "wait_soon", at(10_000));
          const later = yield* park(executionId, "wait_late", at(90_000));
          const released = yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          const { claim } = yield* claimRun(executionId, at(10_000));
          return {
            released,
            claim,
            overdue: yield* executions.findPark(overdue),
            later: yield* executions.findPark(later),
          };
        })
      );

      expect(result.released).toEqual({
        schedule: { state: "waiting", wakeAt: at(10_000), attempt: 0 },
        countedStep: null,
      });
      expect(result.claim.attempt).toBe(0);
      expect(result.overdue).toMatchObject({
        status: "resuming",
        wake: { kind: "timeout" },
      });
      expect(result.later).toMatchObject({ status: "waiting", wake: null });
    });

    // A step may answer any JSON value, and a step whose value is a bare
    // scalar must read back as that scalar rather than fail the write.

    it("stores and reads back every kind of JSON value a step answers", async () => {
      const connection = await seeded(await openConnection());
      const values = {
        flag: true,
        text: "sent",
        count: 3,
        nothing: null,
        list: [1, "two", false],
        record: { id: "msg_1", nested: { ok: true } },
      };
      const memo = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          for (const [stepId, value] of Object.entries(values)) {
            yield* executions
              .fenced(fence)
              .writeStepMemo({ stepId, value, leaseExpiresAt: at(LEASE_MS) });
          }
          return yield* executions.listStepMemo({ executionId });
        })
      );

      expect(
        Object.fromEntries(
          memo.map((entry) => [
            entry.stepId,
            entry.status === "succeeded" ? entry.value : entry.status,
          ])
        )
      ).toEqual(values);
    });

    it("writes each release outcome", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          // Each run has already lost one lease with no step running, so its
          // own failure count stands at one and an outcome that counts a run
          // failure can be told from one that resets the count.
          const release = (outcome: PassOutcome) =>
            Effect.gen(function* () {
              const executionId = yield* scheduledRun(T0);
              yield* claimRun(executionId, T0);
              const { fence } = yield* claimRun(executionId, at(LEASE_MS));
              const released = yield* executions
                .fenced(fence)
                .releasePass({ outcome, now: at(LEASE_MS + 1_000) });
              return {
                executionId,
                released,
                schedule: yield* executions.findSchedule({ executionId }),
                memo: yield* executions.listStepMemo({ executionId }),
              };
            });

          return {
            stepFailed: yield* release({
              kind: "step_failed",
              stepId: "node:send:dispatch",
              error: "vendor timed out",
              backoffMs: 30_000,
            }),
            runFailed: yield* release({
              kind: "run_failed",
              error: "the body failed outside any step",
              backoffMs: 30_000,
            }),
            fenceRefused: yield* release({ kind: "fence_refused" }),
            nothingParked: yield* release({ kind: "parked" }),
          };
        })
      );

      const releasedAt = at(LEASE_MS + 1_000);
      const failing = {
        status: "failing",
        failures: 1,
        error: "vendor timed out",
      };
      expect(result.stepFailed.released).toEqual({
        schedule: {
          state: "queued",
          wakeAt: at(LEASE_MS + 31_000),
          attempt: 0,
        },
        countedStep: failing,
      });
      expect(result.stepFailed.schedule).toMatchObject({
        state: "queued",
        lastError: "vendor timed out",
        runningStepId: null,
        ownerToken: null,
        leaseExpiresAt: null,
        workerId: null,
      });
      expect(result.stepFailed.memo).toEqual([
        { stepId: "node:send:dispatch", ...failing },
      ]);
      expect(result.runFailed.released).toEqual({
        schedule: {
          state: "queued",
          wakeAt: at(LEASE_MS + 31_000),
          attempt: 2,
        },
        countedStep: null,
      });
      expect(result.runFailed.memo).toEqual([]);
      expect(result.fenceRefused.released.schedule).toEqual({
        state: "queued",
        wakeAt: releasedAt,
        attempt: 0,
      });
      // A pass that ended parked with nothing waiting has nothing to sleep on.
      expect(result.nothingParked.released.schedule).toEqual({
        state: "queued",
        wakeAt: releasedAt,
        attempt: 0,
      });
    });

    it("re-queues at release a run whose park was woken while it was leased", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const woken = yield* park(executionId, "wait_a", at(90_000));
          const sleeping = yield* park(executionId, "wait_b", at(120_000));

          // The producer lands mid-pass: it sets the wake but leaves the
          // leased row for the release to notice.
          const duringPass = yield* executions.wakePark({
            executionId,
            waitStateId: woken,
            wake: {
              kind: "resume",
              eventName: "appointment/approved",
              payload: { approved: true },
              deliveryId: "delivery_1",
            },
            now: at(500),
          });
          const secondWake = yield* executions.wakePark({
            executionId,
            waitStateId: woken,
            wake: { kind: "cancel" },
            now: at(600),
          });
          const released = yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });

          // The next pass consumes the wake and parks again on the other Wait,
          // and a producer then wakes a sleeping run directly.
          const { fence: nextFence } = yield* claimRun(executionId, at(1_000));
          yield* executions.markWaitStatus({
            waitStateId: woken,
            status: "resumed",
          });
          const slept = yield* executions
            .fenced(nextFence)
            .releasePass({ outcome: { kind: "parked" }, now: at(2_000) });
          const wakeOnSleeping = yield* executions.wakePark({
            executionId,
            waitStateId: sleeping,
            wake: { kind: "timeout" },
            now: at(3_000),
          });

          return {
            duringPass,
            secondWake,
            released,
            park: yield* executions.findPark(woken),
            slept,
            wakeOnSleeping,
            schedule: yield* executions.findSchedule({ executionId }),
          };
        })
      );

      expect(result.duringPass).toEqual({ resolved: true, requeued: false });
      expect(result.secondWake).toEqual({ resolved: false, requeued: false });
      expect(result.park?.wake).toEqual({
        kind: "resume",
        eventName: "appointment/approved",
        payload: { approved: true },
        deliveryId: "delivery_1",
      });
      expect(result.released.schedule).toEqual({
        state: "queued",
        wakeAt: at(1_000),
        attempt: 0,
      });
      expect(result.slept.schedule).toEqual({
        state: "waiting",
        wakeAt: at(120_000),
        attempt: 0,
      });
      expect(result.wakeOnSleeping).toEqual({ resolved: true, requeued: true });
      expect(result.schedule).toMatchObject({
        state: "queued",
        wakeAt: at(3_000),
      });
    });

    it("deletes the schedule row and step memo with the terminal write and keeps the logs", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const logId = yield* pass.openNodeLog({
            executionId,
            nodeId: "send",
            nodeName: "Send reminder",
            nodeType: "action",
          });
          yield* pass.writeStepMemo({
            stepId: "node:send:log-open",
            value: { logId },
            leaseExpiresAt: at(LEASE_MS),
          });
          const finished = yield* pass.finishRun({
            executionId,
            status: "completed",
          });
          const afterEnd = yield* Effect.flip(
            pass.recordAuditEvent({
              workflowId: "wf_1",
              executionId,
              eventType: "run_completed",
              message: "Run completed",
            })
          );

          // A policy cancel ends a run from outside its pass, and takes the
          // run's schedule row with it the same way.
          const cancelledId = yield* scheduledRun(T0);
          const cancelled = yield* executions.endInFlight({
            executionId: cancelledId,
            status: "canceled",
          });

          return {
            finished,
            afterEnd,
            schedule: yield* executions.findSchedule({ executionId }),
            memo: yield* executions.listStepMemo({ executionId }),
            logs: yield* executions.listLogs(executionId),
            cancelled,
            cancelledSchedule: yield* executions.findSchedule({
              executionId: cancelledId,
            }),
          };
        })
      );

      expect(result.finished).toMatchObject({
        status: "completed",
        didWrite: true,
      });
      expect(result.afterEnd._tag).toBe("LeaseLost");
      expect(result.schedule).toBeNull();
      expect(result.memo).toEqual([]);
      expect(result.logs).toHaveLength(1);
      expect(result.cancelled).toMatchObject({
        status: "canceled",
        didWrite: true,
      });
      expect(result.cancelledSchedule).toBeNull();
    });

    // A fatal failure in one branch writes the run's terminal record while a
    // sibling Wait is still parked, and a parked Wait of a run that ended must
    // not stay addressable by an Event or by the Runs view.

    it("cancels every open wait row of a run in the transaction that ends it", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const parked = yield* park(executionId, "wait_parked", at(90_000));
          const woken = yield* park(executionId, "wait_woken", at(90_000));
          yield* executions.wakePark({
            executionId,
            waitStateId: woken,
            wake: { kind: "timeout" },
            now: at(1_000),
          });
          yield* executions.fenced(fence).finishRun({
            executionId,
            status: "failed",
            error: "A step failed",
          });

          // A policy cancel ends a run from outside its pass the same way.
          const cancelledId = yield* openRun;
          const cancelledWait = yield* park(
            cancelledId,
            "wait_cancelled",
            at(90_000)
          );
          yield* executions.endInFlight({
            executionId: cancelledId,
            status: "canceled",
          });

          return {
            parked: yield* executions.findPark(parked),
            woken: yield* executions.findPark(woken),
            cancelled: yield* executions.findPark(cancelledWait),
            waiting: yield* executions.listWaitingStates(executionId),
          };
        })
      );

      expect(result.parked).toMatchObject({ status: "cancelled" });
      expect(result.woken).toMatchObject({
        status: "cancelled",
        wake: { kind: "timeout" },
      });
      expect(result.cancelled).toMatchObject({ status: "cancelled" });
      expect(result.waiting).toEqual([]);
    });

    it("re-parks a row a Migration or a timeout resolved, clearing its wake", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const wake = (waitStateId: string, parkWake: ParkWake) =>
            Effect.gen(function* () {
              yield* pass.recordParkStep({
                waitStateId,
                parkStepId: `park-${waitStateId}`,
              });
              yield* executions.wakePark({
                executionId,
                waitStateId,
                wake: parkWake,
                now: at(1_000),
              });
            });

          const migrated = yield* park(executionId, "wait_migrated", at(9_000));
          const timedOut = yield* park(executionId, "wait_timed", at(9_000));
          const resumed = yield* park(executionId, "wait_resumed", at(9_000));
          yield* wake(migrated, { kind: "migrate" });
          yield* wake(timedOut, { kind: "timeout" });
          yield* wake(resumed, {
            kind: "resume",
            eventName: "appointment/approved",
            payload: {},
            deliveryId: null,
          });

          return {
            migrated: yield* pass.reparkWait(reparkInput(migrated)),
            timedOut: yield* pass.reparkWait(reparkInput(timedOut)),
            resumed: yield* pass.reparkWait(reparkInput(resumed)),
            migratedPark: yield* executions.findPark(migrated),
            timedOutPark: yield* executions.findPark(timedOut),
            resumedPark: yield* executions.findPark(resumed),
          };
        })
      );

      expect(result.migrated).toEqual({ ok: true });
      expect(result.timedOut).toEqual({ ok: true });
      // An Event's wake is the Wait's to act on, so the re-park leaves it.
      expect(result.resumed).toEqual({ ok: false, reason: "not_waiting" });
      for (const reparked of [result.migratedPark, result.timedOutPark]) {
        expect(reparked).toMatchObject({
          status: "waiting",
          wake: null,
          parkStepId: null,
        });
      }
      expect(result.resumedPark).toMatchObject({
        status: "resuming",
        wake: { kind: "resume" },
      });
    });

    it("keys a run's schedule row by an id of its own, writes it once per run, and deletes it and its memo with the run", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          // A retried delivery asks for the same run again, later.
          const start = (now: Date) =>
            executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                deliveryId: "delivery_1",
                input: {},
              },
              concurrency: "unlimited",
              supersededReason: "newer start",
              startedEntry: notYetDue.startedEntry,
              now,
            });
          const first = yield* start(T0);
          const retried = yield* start(at(5_000));
          if (first.status !== "started" || retried.status !== "started") {
            throw new Error("Start was refused");
          }
          const executionId = first.execution.id;
          const again = retried.execution.id === executionId;
          const entries = yield* executions.listEvents(executionId);
          const { claim, fence } = yield* claimRun(executionId, T0);
          yield* executions.fenced(fence).writeStepMemo({
            stepId: "step_1",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          const schedule = yield* executions.findSchedule({ executionId });
          const memo = yield* executions.listStepMemo({ executionId });
          yield* executions.deleteAllForWorkflow("wf_1");
          return {
            again,
            entries,
            claim,
            schedule,
            memo,
            afterDelete: {
              schedule: yield* executions.findSchedule({ executionId }),
              memo: yield* executions.listStepMemo({ executionId }),
            },
          };
        })
      );

      expect(result.again).toBe(true);
      expect(result.entries.map((entry) => entry.eventType)).toEqual([
        "run_started",
      ]);
      expect(result.schedule).toMatchObject({
        id: result.claim.scheduleId,
        kind: "run",
        executionId: result.claim.executionId,
        wakeAt: T0,
      });
      expect(result.claim.scheduleId).not.toBe(result.claim.executionId);
      expect(result.memo).toHaveLength(1);
      expect(result.afterDelete).toEqual({ schedule: null, memo: [] });
    });

    it("deletes the schedule row and its memo through a pass that found its run no longer in flight", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          yield* pass.writeStepMemo({
            stepId: "step_1",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          yield* pass.dropSchedule();
          return {
            schedule: yield* executions.findSchedule({ executionId }),
            memo: yield* executions.listStepMemo({ executionId }),
            again: yield* Effect.flip(pass.dropSchedule()),
          };
        })
      );

      expect(result.schedule).toBeNull();
      expect(result.memo).toEqual([]);
      expect(result.again._tag).toBe("LeaseLost");
    });

    // A policy cancel ends a run from outside the pass holding it. The
    // terminal write deletes the schedule row in its own transaction, so the
    // pass is stopped by its next fenced write and nothing else has to stop it.

    it("counts each step's failures on its own memo row, so a step that failed three times leaves the next one four retries", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          let clock = 0;
          // One pass whose step `stepId` throws. Each pass claims the row the
          // previous release queued at its own time.
          const failOnce = (stepId: string) =>
            Effect.gen(function* () {
              const { fence } = yield* claimRun(executionId, at(clock));
              const released = yield* executions.fenced(fence).releasePass({
                outcome: {
                  kind: "step_failed",
                  stepId,
                  error: `${stepId} failed`,
                  backoffMs: 1_000,
                },
                now: at(clock),
              });
              clock = released.schedule.wakeAt.getTime() - T0.getTime();
              return released;
            });

          for (let failure = 1; failure <= 3; failure += 1) {
            yield* failOnce("step_a");
          }
          const { fence } = yield* claimRun(executionId, at(clock));
          yield* executions.fenced(fence).writeStepMemo({
            stepId: "step_a",
            value: "sent",
            leaseExpiresAt: at(clock + LEASE_MS),
          });
          yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(clock) });

          const stepB = [];
          for (let failure = 1; failure <= 5; failure += 1) {
            stepB.push(yield* failOnce("step_b"));
          }

          // A step whose row is `failed` keeps it when a late value arrives.
          const { fence: last } = yield* claimRun(executionId, at(clock));
          yield* executions.fenced(last).writeStepMemo({
            stepId: "step_b",
            value: "late",
            leaseExpiresAt: at(clock + LEASE_MS),
          });
          return {
            stepB,
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      expect(result.stepB.map((released) => released.countedStep)).toEqual([
        { status: "failing", failures: 1, error: "step_b failed" },
        { status: "failing", failures: 2, error: "step_b failed" },
        { status: "failing", failures: 3, error: "step_b failed" },
        { status: "failing", failures: 4, error: "step_b failed" },
        { status: "failed", failures: 5, error: "step_b failed" },
      ]);
      // A step within its retries waits out its backoff; a step whose retries
      // are spent re-queues the run at once, so its node fails on the next pass.
      const [fourth, fifth] = result.stepB.slice(3);
      expect(fourth?.schedule).toMatchObject({ state: "queued", attempt: 0 });
      expect(fifth?.schedule.wakeAt.getTime()).toBeLessThan(
        (fourth?.schedule.wakeAt.getTime() ?? 0) + 1_000
      );
      expect(
        Object.fromEntries(
          result.memo.map(({ stepId, ...entry }) => [stepId, entry])
        )
      ).toEqual({
        step_a: { status: "succeeded", failures: 3, value: "sent" },
        step_b: { status: "failed", failures: 5, error: "step_b failed" },
      });
    });

    it("counts a lease that expires under a recorded step against that step, and fails the step past the limit", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const attempts = [];
          const memoAfterFirstExpiry = [];
          let clock = 0;
          // Five passes in a row stop renewing their lease while the same step
          // runs, the way a step that hangs past every lease does. Each claim
          // after the first sweeps the lease the pass before it left.
          for (let pass = 1; pass <= 5; pass += 1) {
            const { claim, fence } = yield* claimRun(executionId, at(clock));
            attempts.push(claim.attempt);
            if (pass === 2) {
              memoAfterFirstExpiry.push(
                ...(yield* executions.listStepMemo({ executionId }))
              );
            }
            yield* executions.fenced(fence).renewLease({
              leaseExpiresAt: at(clock + LEASE_MS),
              runningStepId: "step_slow",
            });
            clock += LEASE_MS + 1;
          }
          const { claim: last } = yield* claimRun(executionId, at(clock));
          attempts.push(last.attempt);
          return {
            attempts,
            memoAfterFirstExpiry,
            schedule: yield* executions.findSchedule({ executionId }),
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      // The run's own count is left alone, because a step was recorded.
      expect(result.attempts).toEqual([0, 0, 0, 0, 0, 0]);
      expect(result.memoAfterFirstExpiry).toEqual([
        {
          stepId: "step_slow",
          status: "failing",
          failures: 1,
          error: LEASE_EXPIRED_ERROR,
        },
      ]);
      // The claim clears the step the swept pass recorded.
      expect(result.schedule).toMatchObject({
        state: "leased",
        runningStepId: null,
        attempt: 0,
      });
      expect(result.memo).toEqual([
        {
          stepId: "step_slow",
          status: "failed",
          failures: 5,
          error: LEASE_EXPIRED_ERROR,
        },
      ]);
    });

    it("counts a lease that expires between steps against the run, and resets that count at the next release", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);

          // The first pass records a step and then finishes it, so the lease
          // expires with no step running.
          const { fence } = yield* claimRun(executionId, T0);
          yield* executions.fenced(fence).renewLease({
            leaseExpiresAt: at(LEASE_MS),
            runningStepId: "step_done",
          });
          yield* executions.fenced(fence).writeStepMemo({
            stepId: "step_done",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          const afterMemo = yield* executions.findSchedule({ executionId });

          const { claim: second } = yield* claimRun(
            executionId,
            at(LEASE_MS + 1)
          );
          const { claim: third, fence: thirdFence } = yield* claimRun(
            executionId,
            at(LEASE_MS * 2 + 2)
          );
          const released = yield* executions.fenced(thirdFence).releasePass({
            outcome: { kind: "parked" },
            now: at(LEASE_MS * 2 + 3),
          });
          return {
            afterMemo,
            second,
            third,
            released,
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      // The memo write stopped naming its step as running.
      expect(result.afterMemo?.runningStepId).toBeNull();
      expect(result.second.attempt).toBe(1);
      expect(result.third.attempt).toBe(2);
      expect(result.released.schedule.attempt).toBe(0);
      expect(result.memo).toEqual([
        {
          stepId: "step_done",
          status: "succeeded",
          failures: 0,
          value: "sent",
        },
      ]);
    });
  });
}
