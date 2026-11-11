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
import {
  BUDGET_CUT_ERROR,
  LEASE_EXPIRED_ERROR,
} from "#src/backend/services/executions/repo/release-policy";
import {
  type PersistenceTestRegistry,
  notYetDue,
  verdict,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  LEASE_MS,
  at,
  scheduledRun,
  openRun,
  claimRun,
  memoWrite,
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
            lanes: [{ kind: "run", limit: 1 }],
            workerId: "worker_a",
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
            lanes: [{ kind: "run", limit: 10 }],
            workerId: "worker_2",
            leaseMs: LEASE_MS,
            now: at(LEASE_MS - 1),
          });
          const { claim: second } = yield* claimRun(
            executionId,
            at(LEASE_MS + 1)
          );
          const staleWrite = yield* Effect.flip(
            executions.fenced(staleFence).writeStepMemo(
              memoWrite({
                stepId: "step_1",
                value: "stale",
                leaseExpiresAt: at(LEASE_MS * 3),
              })
            )
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
            yield* executions.fenced(fence).writeStepMemo(
              memoWrite({
                stepId,
                value,
                leaseExpiresAt: at(LEASE_MS),
              })
            );
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
              nodeId: "send",
              stepId: "node:send:dispatch",
              error: "vendor timed out",
              backoffMs: 30_000,
            }),
            runFailed: yield* release({
              kind: "body_failed",
              error: "the body failed outside any step",
              backoffMs: 30_000,
            }),
            fenceRefused: yield* release({
              kind: "fence_refused",
              backoffMs: 1_000,
            }),
            nothingParked: yield* release({ kind: "parked" }),
            drained: yield* release({
              kind: "interrupted",
              by: "drain",
              wakeAfterMs: 0,
            }),
            budgetCut: yield* release({
              kind: "interrupted",
              by: "budget",
              nodeId: "send",
              stepId: "node:send:dispatch",
              wakeAfterMs: 0,
            }),
            budgetCutBetweenSteps: yield* release({
              kind: "interrupted",
              by: "budget",
              nodeId: null,
              stepId: null,
              wakeAfterMs: 0,
            }),
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
      // The memo row the failure created names the step's node.
      expect(result.stepFailed.memo).toEqual([
        { stepId: "node:send:dispatch", nodeId: "send", ...failing },
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
      // A refused fence counts nothing and keeps the row's own count.
      expect(result.fenceRefused.released.schedule).toEqual({
        state: "queued",
        wakeAt: at(LEASE_MS + 2_000),
        attempt: 1,
      });
      // A pass that ended parked with nothing waiting has nothing to sleep on.
      expect(result.nothingParked.released.schedule).toEqual({
        state: "queued",
        wakeAt: releasedAt,
        attempt: 0,
      });
      // An interruption keeps the row's own count and re-queues it at once. A
      // graceful drain counts nothing; a budget cut counts one failure on the
      // step that was running, and nothing when no step was.
      const interrupted = {
        schedule: { state: "queued", wakeAt: releasedAt, attempt: 1 },
        countedStep: null,
      };
      expect(result.drained.released).toEqual(interrupted);
      expect(result.drained.memo).toEqual([]);
      expect(result.budgetCutBetweenSteps.released).toEqual(interrupted);
      expect(result.budgetCutBetweenSteps.memo).toEqual([]);
      const cut = {
        status: "failing",
        failures: 1,
        error: BUDGET_CUT_ERROR,
      };
      expect(result.budgetCut.released).toEqual({
        ...interrupted,
        countedStep: cut,
      });
      expect(result.budgetCut.schedule).toMatchObject({
        lastError: BUDGET_CUT_ERROR,
      });
      expect(result.budgetCut.memo).toEqual([
        { stepId: "node:send:dispatch", nodeId: "send", ...cut },
      ]);
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

    // The run-ending table in `execution-run-endings.ts` holds every ending to deleting
    // the schedule row and memo. This case adds what it does not read: the
    // node logs stay, and the pass that ended the run is refused afterwards.
    it("keeps the logs of a run its own pass ended, and refuses that pass's next fenced write", async () => {
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
          yield* pass.writeStepMemo(
            memoWrite({
              stepId: "node:send:log-open",
              value: { logId },
              leaseExpiresAt: at(LEASE_MS),
            })
          );
          const finished = yield* pass.endRun({
            executionId,
            ending: verdict("completed"),
          });
          const afterEnd = yield* Effect.flip(
            pass.recordAuditEvent({
              workflowId: "wf_1",
              executionId,
              eventType: "run_completed",
              message: "Run completed",
            })
          );

          return {
            finished,
            afterEnd,
            schedule: yield* executions.findSchedule({ executionId }),
            memo: yield* executions.listStepMemo({ executionId }),
            logs: yield* executions.listLogs(executionId),
            ending: (yield* executions.listEvents(executionId))
              .filter((event) => event.eventType !== "run_started")
              .map((event) => event.eventType),
          };
        })
      );

      expect(result.finished).toEqual({ kind: "ended", status: "completed" });
      expect(result.afterEnd._tag).toBe("LeaseLost");
      expect(result.schedule).toBeNull();
      expect(result.memo).toEqual([]);
      expect(result.logs).toHaveLength(1);
      expect(result.ending).toEqual(["run_completed"]);
    });

    // A fatal failure in one branch writes the run's terminal record while a
    // sibling Wait is still parked, and a parked Wait of a run that ended must
    // not stay addressable by an Event or by the Runs view. The run-ending
    // table parks one Wait; this case holds a woken one beside it.

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
          yield* executions.fenced(fence).endRun({
            executionId,
            ending: { kind: "outsideGraph", error: "A step failed" },
          });

          return {
            parked: yield* executions.findPark(parked),
            woken: yield* executions.findPark(woken),
            waiting: yield* executions.listWaitingStates(executionId),
          };
        })
      );

      expect(result.parked).toMatchObject({ status: "cancelled" });
      expect(result.woken).toMatchObject({
        status: "cancelled",
        wake: { kind: "timeout" },
      });
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
          yield* executions.fenced(fence).writeStepMemo(
            memoWrite({
              stepId: "step_1",
              value: "sent",
              leaseExpiresAt: at(LEASE_MS),
            })
          );
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
          yield* pass.writeStepMemo(
            memoWrite({
              stepId: "step_1",
              value: "sent",
              leaseExpiresAt: at(LEASE_MS),
            })
          );
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
                  nodeId: null,
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
          yield* executions.fenced(fence).writeStepMemo(
            memoWrite({
              stepId: "step_a",
              value: "sent",
              leaseExpiresAt: at(clock + LEASE_MS),
            })
          );
          yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(clock) });

          const stepB = [];
          for (let failure = 1; failure <= 5; failure += 1) {
            stepB.push(yield* failOnce("step_b"));
          }

          // A step whose row is `failed` keeps it when a late value arrives.
          const { fence: last } = yield* claimRun(executionId, at(clock));
          yield* executions.fenced(last).writeStepMemo(
            memoWrite({
              stepId: "step_b",
              value: "late",
              leaseExpiresAt: at(clock + LEASE_MS),
            })
          );
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
        step_a: {
          nodeId: null,
          status: "succeeded",
          failures: 3,
          value: "sent",
        },
        step_b: {
          nodeId: null,
          status: "failed",
          failures: 5,
          error: "step_b failed",
        },
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
              runningNodeId: "slow",
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
      // The swept failure lands on a memo row naming the node the heartbeat
      // recorded beside the step.
      expect(result.memoAfterFirstExpiry).toEqual([
        {
          stepId: "step_slow",
          nodeId: "slow",
          status: "failing",
          failures: 1,
          error: LEASE_EXPIRED_ERROR,
        },
      ]);
      // The claim clears the step the swept pass recorded.
      expect(result.schedule).toMatchObject({
        state: "leased",
        runningStepId: null,
        runningNodeId: null,
        attempt: 0,
      });
      expect(result.memo).toEqual([
        {
          stepId: "step_slow",
          nodeId: "slow",
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
            runningNodeId: "done",
          });
          const whileRunning = yield* executions.findSchedule({ executionId });
          yield* executions.fenced(fence).writeStepMemo({
            nodeId: "done",
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
            whileRunning,
            afterMemo,
            second,
            third,
            released,
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      // The heartbeat recorded the step and its node, and the memo write
      // stopped naming either as running.
      expect(result.whileRunning).toMatchObject({
        runningStepId: "step_done",
        runningNodeId: "done",
      });
      expect(result.afterMemo?.runningStepId).toBeNull();
      expect(result.afterMemo?.runningNodeId).toBeNull();
      expect(result.second.attempt).toBe(1);
      expect(result.third.attempt).toBe(2);
      expect(result.released.schedule.attempt).toBe(0);
      expect(result.memo).toEqual([
        {
          stepId: "step_done",
          nodeId: "done",
          status: "succeeded",
          failures: 0,
          value: "sent",
        },
      ]);
    });

    it("names no step on a heartbeat that lands after that step's memo write, so the expired lease counts against the run", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const writes = executions.fenced(fence);
          yield* writes.writeStepMemo({
            nodeId: "done",
            stepId: "step_done",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          // The heartbeat read the step as running before its memo write
          // committed, and its own write lands after.
          yield* writes.renewLease({
            leaseExpiresAt: at(LEASE_MS),
            runningStepId: "step_done",
            runningNodeId: "done",
          });
          const afterLateBeat = yield* executions.findSchedule({ executionId });
          yield* writes.renewLease({
            leaseExpiresAt: at(LEASE_MS),
            runningStepId: "step_next",
            runningNodeId: "next",
          });
          const afterNextBeat = yield* executions.findSchedule({ executionId });
          yield* writes.renewLease({
            leaseExpiresAt: at(LEASE_MS),
            runningStepId: "step_done",
            runningNodeId: "done",
          });
          const { claim } = yield* claimRun(executionId, at(LEASE_MS + 1));
          return {
            afterLateBeat,
            afterNextBeat,
            claim,
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      expect(result.afterLateBeat).toMatchObject({
        runningStepId: null,
        runningNodeId: null,
      });
      expect(result.afterNextBeat).toMatchObject({
        runningStepId: "step_next",
        runningNodeId: "next",
      });
      expect(result.claim.attempt).toBe(1);
      expect(result.memo).toEqual([
        {
          stepId: "step_done",
          nodeId: "done",
          status: "succeeded",
          failures: 0,
          value: "sent",
        },
      ]);
    });

    it("counts a lease that expires under a step whose memo row has settled against the run", async () => {
      const database = await openDatabase();
      const connection = await seeded(await database.open());
      const { executionId, scheduleId } = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const run = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(run, T0);
          yield* executions.fenced(fence).writeStepMemo({
            nodeId: "done",
            stepId: "step_done",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          return { executionId: run, scheduleId: fence.scheduleId };
        })
      );
      // The row names the finished step, as a heartbeat that raced its memo
      // write left it before heartbeats checked the memo.
      await database.execute(
        `update workflow_execution_schedule set running_step_id = 'step_done', running_node_id = 'done' where id = '${scheduleId}'`
      );

      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const { claim } = yield* claimRun(executionId, at(LEASE_MS + 1));
          return {
            claim,
            memo: yield* executions.listStepMemo({ executionId }),
          };
        })
      );

      expect(result.claim.attempt).toBe(1);
      expect(result.memo).toMatchObject([
        { stepId: "step_done", status: "succeeded", failures: 0 },
      ]);
    });

    it("holds a schedule row's lease columns to its leased state", async () => {
      const database = await openDatabase();
      const connection = await seeded(await database.open());
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* openRun;
          const schedule = yield* executions.findSchedule({ executionId });
          if (!schedule) throw new Error("The run has no schedule row");
          return schedule.id;
        })
      );
      const row = `id = '${scheduleId}'`;
      const update = "update workflow_execution_schedule set";
      const expiry = at(LEASE_MS);
      const lease = {
        postgresql: `owner_token = 'tok_1', worker_id = 'worker_1', lease_expires_at = '${expiry.toISOString()}'`,
        sqlite: `owner_token = 'tok_1', worker_id = 'worker_1', lease_expires_at = ${expiry.getTime()}`,
      };

      await expect(
        database.execute(`${update} state = 'leased' where ${row}`)
      ).rejects.toThrow();
      await expect(
        database.execute({
          postgresql: `${update} ${lease.postgresql} where ${row}`,
          sqlite: `${update} ${lease.sqlite} where ${row}`,
        })
      ).rejects.toThrow();
      await expect(
        database.execute(`${update} running_step_id = 'step_1' where ${row}`)
      ).rejects.toThrow();
      await expect(
        database.execute({
          postgresql: `${update} state = 'leased', owner_token = 'tok_1', lease_expires_at = '${expiry.toISOString()}' where ${row}`,
          sqlite: `${update} state = 'leased', owner_token = 'tok_1', lease_expires_at = ${expiry.getTime()} where ${row}`,
        })
      ).rejects.toThrow();
      await expect(
        database.execute({
          postgresql: `${update} state = 'leased', running_step_id = 'step_1', ${lease.postgresql} where ${row}`,
          sqlite: `${update} state = 'leased', running_step_id = 'step_1', ${lease.sqlite} where ${row}`,
        })
      ).resolves.toBeUndefined();
    });

    it("holds a step memo row's value and failure count to its status", async () => {
      const database = await openDatabase();
      const connection = await seeded(await database.open());
      const scheduleId = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* openRun;
          const schedule = yield* executions.findSchedule({ executionId });
          if (!schedule) throw new Error("The run has no schedule row");
          return schedule.id;
        })
      );
      const memo = (
        stepId: string,
        row: { status: string; failures: number; value: string; error: string }
      ) => {
        const columns = "schedule_id, step_id, status, failures, value, error";
        const values = `'${scheduleId}', '${stepId}', '${row.status}', ${row.failures}, ${row.value}, ${row.error}`;
        return database.execute({
          postgresql: `insert into workflow_execution_steps (${columns}) values (${values})`,
          sqlite: `insert into workflow_execution_steps (${columns}, created_at) values (${values}, 0)`,
        });
      };

      // Only a step that answered holds an answer.
      await expect(
        memo("failing_with_value", {
          status: "failing",
          failures: 1,
          value: "'1'",
          error: "'boom'",
        })
      ).rejects.toThrow();
      // A failing or failed row counts at least the failure that made it.
      await expect(
        memo("failing_without_failure", {
          status: "failing",
          failures: 0,
          value: "null",
          error: "'boom'",
        })
      ).rejects.toThrow();
      await expect(
        memo("failed_without_failure", {
          status: "failed",
          failures: 0,
          value: "null",
          error: "'boom'",
        })
      ).rejects.toThrow();
      await expect(
        memo("succeeded_negative", {
          status: "succeeded",
          failures: -1,
          value: "'1'",
          error: "null",
        })
      ).rejects.toThrow();
      await expect(
        memo("failing", {
          status: "failing",
          failures: 1,
          value: "null",
          error: "'boom'",
        })
      ).resolves.toBeUndefined();
      await expect(
        memo("succeeded_after_retries", {
          status: "succeeded",
          failures: 2,
          value: "'1'",
          error: "null",
        })
      ).resolves.toBeUndefined();
    });
  });
}
