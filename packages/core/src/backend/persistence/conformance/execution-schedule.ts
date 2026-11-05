/**
 * The executions aggregate's schedule rows and step memo, which the database
 * executor runs on: what a claim leases, what a release writes back, what a
 * producer's wake does to a parked run, which writes a pass's fence refuses,
 * and what a terminal write leaves behind.
 *
 * Every case passes its own clock to the claim and the release, so the due and
 * lease comparisons do not depend on how fast the case runs.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  ExecutionRepo,
  type OwnerFence,
  type ParkWake,
  type PassOutcome,
  type RepinParks,
} from "#src/backend/services/executions/repo";
import { LEASE_EXPIRED_ERROR } from "#src/backend/services/executions/repo/release-policy";
import type {
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import {
  publishSecondVersion,
  seedPublishedWorkflow,
} from "#src/backend/persistence/conformance/support";

const T0 = new Date("2026-03-01T09:00:00.000Z");
const LEASE_MS = 60_000;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** Opens one run against the seeded workflow and answers its id. */
const openRun = Effect.gen(function* () {
  const executions = yield* ExecutionRepo;
  const started = yield* executions.startForEntity({
    execution: {
      workflowId: "wf_1",
      workflowVersionId: "ver_1",
      startSource: "manual",
      runMode: "live",
      input: {},
    },
    concurrency: "unlimited",
    supersededReason: "newer start",
  });
  if (started.status !== "started") throw new Error("Start was refused");
  return started.execution.id;
});

/** Opens a run and gives it a schedule row due at `wakeAt`. */
function scheduledRun(wakeAt: Date) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const executionId = yield* openRun;
    yield* executions.scheduleExecution({ executionId, kind: "run", wakeAt });
    return executionId;
  });
}

/** Claims every due row at `now` and answers the one for `executionId`. */
function claimRun(executionId: string, now: Date) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const claimed = yield* executions.claimDue({
      workerId: "worker_1",
      limit: 10,
      leaseMs: LEASE_MS,
      now,
    });
    const own = claimed.find((row) => row.executionId === executionId);
    if (!own) throw new Error("The run was not claimed");
    const fence: OwnerFence = {
      scheduleId: own.scheduleId,
      executionId,
      ownerToken: own.ownerToken,
    };
    return { claim: own, fence };
  });
}

/** Parks the run on one event Wait whose deadline is `waitUntil`. */
function park(executionId: string, nodeId: string, waitUntil: Date) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const wait = yield* executions.startWait({
      side: "started",
      executionId,
      workflowId: "wf_1",
      runId: "run_1",
      nodeId,
      nodeName: nodeId,
      workflowVersionId: "ver_1",
      waitType: "event",
      resumeToken: `${executionId}-${nodeId}`,
      waitUntil,
      subscribedEvents: ["appointment/approved"],
    });
    if (!wait) throw new Error("The park was refused");
    return wait.waitStateId;
  });
}

/** One worker's claim of at most one row due five seconds after `T0`. */
function claimOne(connection: ConformanceConnection, workerId: string) {
  return connection.run(
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      return yield* executions.claimDue({
        workerId,
        limit: 1,
        leaseMs: LEASE_MS,
        now: at(5_000),
      });
    })
  );
}

/** The tag of the failure a write answers, for a write the case expects refused. */
function refusalOf<A>(write: Effect.Effect<A, { _tag: string }>) {
  return Effect.flip(write).pipe(Effect.map((failure) => failure._tag));
}

async function seeded(connection: ConformanceConnection) {
  await seedPublishedWorkflow(connection);
  return connection;
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
      const leased = [...fromFirst, ...fromSecond].map(
        (row) => row.executionId
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
            workerId: "worker_a",
            limit: 1,
            leaseMs: LEASE_MS,
            now: at(5_000),
          });
          return { fresh, claimed: claimed.map((row) => row.executionId) };
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
            memo: yield* executions.listStepMemo(executionId),
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
          return yield* executions.listStepMemo(executionId);
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
                schedule: yield* executions.findSchedule(executionId),
                memo: yield* executions.listStepMemo(executionId),
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
          const duringPass = yield* executions.resolvePark({
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
          const secondWake = yield* executions.resolvePark({
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
          const wakeOnSleeping = yield* executions.resolvePark({
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
            schedule: yield* executions.findSchedule(executionId),
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

    it("refuses a stale pass's memo and store writes and writes nothing", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const waitStateId = yield* park(executionId, "wait_1", at(90_000));
          const live = executions.fenced(fence);
          yield* live.writeStepMemo({
            stepId: "node:a:log-open",
            value: { logId: "log_a" },
            leaseExpiresAt: at(LEASE_MS * 2),
          });
          yield* live.recordParkStep({ waitStateId, parkStepId: "wait:1" });
          yield* live.releasePass({
            outcome: { kind: "parked" },
            now: at(1_000),
          });

          // The pass released its row, so its token names no lease.
          const stale = executions.fenced(fence);
          const forged = executions.fenced({
            ...fence,
            ownerToken: "not-a-token",
          });
          return {
            memo: yield* Effect.flip(
              stale.writeStepMemo({
                stepId: "node:b:log-open",
                value: null,
                leaseExpiresAt: at(LEASE_MS * 2),
              })
            ),
            markRunning: yield* Effect.flip(
              stale.markRunning({
                executionId,
                workflowVersionId: "ver_1",
                side: "started",
              })
            ),
            finishRun: yield* Effect.flip(
              forged.finishRun({ executionId, status: "completed" })
            ),
            audit: yield* Effect.flip(
              stale.recordAuditEvent({
                workflowId: "wf_1",
                executionId,
                eventType: "run_resumed",
                message: "Run resumed",
              })
            ),
            dropped: yield* Effect.flip(stale.dropSchedule()),
            memoRows: yield* executions.listStepMemo(executionId),
            park: yield* executions.findPark(waitStateId),
            status: yield* executions.findStatusById(executionId),
            events: yield* executions.listEvents(executionId),
            schedule: yield* executions.findSchedule(executionId),
          };
        })
      );

      expect(result.memo._tag).toBe("LeaseLost");
      expect(result.markRunning._tag).toBe("LeaseLost");
      expect(result.finishRun._tag).toBe("LeaseLost");
      expect(result.audit._tag).toBe("LeaseLost");
      expect(result.dropped._tag).toBe("LeaseLost");
      expect(result.memoRows).toEqual([
        {
          stepId: "node:a:log-open",
          status: "succeeded",
          failures: 0,
          value: { logId: "log_a" },
        },
      ]);
      expect(result.park).toMatchObject({ parkStepId: "wait:1", wake: null });
      expect(result.status?.status).toBe("waiting");
      expect(result.events).toEqual([]);
      expect(result.schedule).toMatchObject({ state: "waiting" });
    });

    it("keeps one log row when its open re-runs, and writes every timeline entry", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const open = {
            executionId,
            nodeId: "send",
            nodeName: "Send reminder",
            nodeType: "action",
            input: { to: "patient" },
          };
          const firstId = yield* pass.openNodeLog(open);
          const secondId = yield* pass.openNodeLog(open);
          // Two identical entries are both kept: the same Wait can park twice,
          // for example after a Migration.
          const entry = {
            workflowId: "wf_1",
            executionId,
            eventType: "run_waiting" as const,
            message: "Run waiting in event node 'Approval'",
            metadata: { nodeId: "wait_1" },
          };
          yield* pass.recordAuditEvent(entry);
          yield* pass.recordAuditEvent(entry);
          return {
            firstId,
            secondId,
            logs: yield* executions.listLogs(executionId),
            events: yield* executions.listEvents(executionId),
          };
        })
      );

      expect(result.secondId).toBe(result.firstId);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).toMatchObject({
        id: result.firstId,
        status: "running",
      });
      expect(result.events).toHaveLength(2);
    });

    it("lets a later fenced close correct an error verdict and keeps a success", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const openLog = (nodeId: string) =>
            pass.openNodeLog({
              executionId,
              nodeId,
              nodeName: nodeId,
              nodeType: "action",
            });

          // An attempt closes its row as an error and rethrows; the retry
          // that follows succeeds.
          const retried = yield* openLog("retried");
          yield* pass.closeNodeLog({
            logId: retried,
            status: "error",
            error: "vendor timed out",
            durationMs: 5,
          });
          yield* pass.closeNodeLog({
            logId: retried,
            status: "success",
            output: { sid: "SM1" },
            durationMs: 12,
          });

          // A row closed as a success keeps that verdict.
          const succeeded = yield* openLog("succeeded");
          yield* pass.closeNodeLog({
            logId: succeeded,
            status: "success",
            output: { sid: "SM2" },
            durationMs: 7,
          });
          yield* pass.closeNodeLog({
            logId: succeeded,
            status: "error",
            error: "second answer",
            durationMs: 3,
          });

          const logs = yield* executions.listLogs(executionId);
          return {
            retried: logs.find((log) => log.id === retried),
            succeeded: logs.find((log) => log.id === succeeded),
          };
        })
      );

      expect(result.retried).toMatchObject({
        status: "success",
        output: { sid: "SM1" },
        error: null,
        duration: "12",
      });
      expect(result.succeeded).toMatchObject({
        status: "success",
        output: { sid: "SM2" },
        error: null,
        duration: "7",
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
            schedule: yield* executions.findSchedule(executionId),
            memo: yield* executions.listStepMemo(executionId),
            logs: yield* executions.listLogs(executionId),
            cancelled,
            cancelledSchedule: yield* executions.findSchedule(cancelledId),
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
          yield* executions.resolvePark({
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
            open: yield* executions.listActiveWaitStates(executionId),
          };
        })
      );

      expect(result.parked).toMatchObject({ status: "cancelled" });
      expect(result.woken).toMatchObject({
        status: "cancelled",
        wake: { kind: "timeout" },
      });
      expect(result.cancelled).toMatchObject({ status: "cancelled" });
      expect(result.open).toEqual([]);
    });

    it("resolves the run's other parks as an Exit in the fenced write that wins the Exit claim", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const sibling = yield* park(executionId, "wait_sibling", at(90_000));
          const won = yield* pass.requestExit({
            executionId,
            reason: "entity_condition_not_met",
            nodeId: "send",
            requestedAt: at(1_000),
          });
          const parkedAfter = yield* executions.startWait({
            side: "started",
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_after",
            nodeName: "wait_after",
            workflowVersionId: "ver_1",
            waitType: "delay",
            waitUntil: at(90_000),
          });
          const lost = yield* pass.requestExit({
            executionId,
            reason: "entity_condition_not_met",
            nodeId: "other",
            requestedAt: at(2_000),
          });
          const released = yield* pass.releasePass({
            outcome: { kind: "parked" },
            now: at(3_000),
          });
          return {
            won,
            lost,
            sibling: yield* executions.findPark(sibling),
            parkedAfter,
            released,
          };
        })
      );

      expect(result.won).toMatchObject({ didWrite: true });
      expect(result.lost).toMatchObject({ didWrite: false });
      expect(result.sibling).toMatchObject({
        status: "resuming",
        wake: { kind: "exit" },
      });
      // The claim refuses every later park, so nothing new is left open.
      expect(result.parkedAfter).toBeUndefined();
      // The release reads the Exit wakes and hands the run straight back.
      expect(result.released.schedule).toMatchObject({
        state: "queued",
        wakeAt: at(3_000),
      });
    });

    it("re-parks a row a Migration or a timeout resolved, clearing its wake", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          const reparkInput = (waitStateId: string) => ({
            waitStateId,
            workflowVersionId: "ver_1",
            side: "started" as const,
            waitType: "delay" as const,
            waitUntil: at(120_000),
            subscribedEvents: [],
            resumeToken: null,
            metadata: {},
          });
          const wake = (waitStateId: string, parkWake: ParkWake) =>
            Effect.gen(function* () {
              yield* pass.recordParkStep({
                waitStateId,
                parkStepId: `park-${waitStateId}`,
              });
              yield* executions.resolvePark({
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

    it("keys a run's schedule row by an id of its own, one row per run, and deletes it and its memo with the run", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const again = yield* executions.scheduleExecution({
            executionId,
            kind: "run",
            wakeAt: at(5_000),
          });
          const { claim, fence } = yield* claimRun(executionId, T0);
          yield* executions.fenced(fence).writeStepMemo({
            stepId: "step_1",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          const schedule = yield* executions.findSchedule(executionId);
          const memo = yield* executions.listStepMemo(executionId);
          yield* executions.deleteAllForWorkflow("wf_1");
          return {
            again,
            claim,
            schedule,
            memo,
            afterDelete: {
              schedule: yield* executions.findSchedule(executionId),
              memo: yield* executions.listStepMemo(executionId),
            },
          };
        })
      );

      expect(result.again).toBe(false);
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
            schedule: yield* executions.findSchedule(executionId),
            memo: yield* executions.listStepMemo(executionId),
            again: yield* Effect.flip(pass.dropSchedule()),
          };
        })
      );

      expect(result.schedule).toBeNull();
      expect(result.memo).toEqual([]);
      expect(result.again._tag).toBe("LeaseLost");
    });

    it("revokes a pass's lease, queueing the row due now and keeping its step memo", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          yield* pass.renewLease({
            leaseExpiresAt: at(LEASE_MS * 2),
            runningStepId: "step_2",
          });
          yield* pass.writeStepMemo({
            stepId: "step_1",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS * 2),
          });
          const revoked = yield* executions.revokeLease({
            executionId,
            now: at(1_000),
          });
          return {
            revoked,
            staleWrite: yield* refusalOf(
              pass.writeStepMemo({
                stepId: "step_2",
                value: "stale",
                leaseExpiresAt: at(LEASE_MS * 3),
              })
            ),
            schedule: yield* executions.findSchedule(executionId),
            memo: yield* executions.listStepMemo(executionId),
            unscheduled: yield* executions.revokeLease({
              executionId: yield* openRun,
              now: at(1_000),
            }),
          };
        })
      );

      expect(result.revoked).toBe(true);
      expect(result.staleWrite).toBe("LeaseLost");
      expect(result.schedule).toMatchObject({
        state: "queued",
        wakeAt: at(1_000),
        ownerToken: null,
        leaseExpiresAt: null,
        workerId: null,
        runningStepId: null,
      });
      expect(result.memo.map((entry) => entry.stepId)).toEqual(["step_1"]);
      expect(result.unscheduled).toBe(false);
    });

    // A count kept for the whole run would hand each later step the retries
    // its predecessors spent.
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
            memo: yield* executions.listStepMemo(executionId),
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
                ...(yield* executions.listStepMemo(executionId))
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
            schedule: yield* executions.findSchedule(executionId),
            memo: yield* executions.listStepMemo(executionId),
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
          const afterMemo = yield* executions.findSchedule(executionId);

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
            memo: yield* executions.listStepMemo(executionId),
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

    it("refuses a fenced write that addresses a run the fence does not name", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const ownId = yield* openRun;
          // The other run is leased to a pass of its own first.
          const otherId = yield* scheduledRun(T0);
          const { fence: otherFence } = yield* claimRun(otherId, T0);
          yield* executions.scheduleExecution({
            executionId: ownId,
            kind: "run",
            wakeAt: T0,
          });
          const { fence } = yield* claimRun(ownId, T0);
          const pass = executions.fenced(fence);
          // The pass's own token and schedule row, paired with the other run.
          const crossed = executions.fenced({
            ...fence,
            executionId: otherId,
          });
          return {
            markRunning: yield* refusalOf(
              pass.markRunning({
                executionId: otherId,
                workflowVersionId: "ver_1",
                side: "started",
              })
            ),
            finishRun: yield* refusalOf(
              pass.finishRun({ executionId: otherId, status: "completed" })
            ),
            openNodeLog: yield* refusalOf(
              pass.openNodeLog({
                executionId: otherId,
                nodeId: "send",
                nodeName: "Send",
                nodeType: "action",
              })
            ),
            audit: yield* refusalOf(
              pass.recordAuditEvent({
                workflowId: "wf_1",
                executionId: otherId,
                eventType: "run_resumed",
                message: "Run resumed",
              })
            ),
            crossedFinish: yield* refusalOf(
              crossed.finishRun({ executionId: otherId, status: "completed" })
            ),
            crossedMemo: yield* refusalOf(
              crossed.writeStepMemo({
                stepId: "step_1",
                value: null,
                leaseExpiresAt: at(LEASE_MS),
              })
            ),
            other: yield* executions.findStatusById(otherId),
            otherLogs: yield* executions.listLogs(otherId),
            otherEvents: yield* executions.listEvents(otherId),
            otherSchedule: yield* executions.findSchedule(otherId),
            otherFence,
          };
        })
      );

      expect(result).toMatchObject({
        markRunning: "LeaseLost",
        finishRun: "LeaseLost",
        openNodeLog: "LeaseLost",
        audit: "LeaseLost",
        crossedFinish: "LeaseLost",
        crossedMemo: "LeaseLost",
      });
      expect(result.other?.status).toBe("running");
      expect(result.otherLogs).toEqual([]);
      expect(result.otherEvents).toEqual([]);
      expect(result.otherSchedule).toMatchObject({
        state: "leased",
        ownerToken: result.otherFence.ownerToken,
      });
    });

    it("re-queues a waiting run only when the producer's wake landed", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const consumed = yield* park(executionId, "wait_a", at(90_000));
          yield* park(executionId, "wait_b", at(120_000));
          yield* executions.resolvePark({
            executionId,
            waitStateId: consumed,
            wake: { kind: "timeout" },
            now: at(500),
          });
          // The pass consumed the wake on `wait_a` and the other Wait sleeps.
          yield* executions.markWaitStatus({
            waitStateId: consumed,
            status: "timed_out",
          });
          const released = yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          const late = yield* executions.resolvePark({
            executionId,
            waitStateId: consumed,
            wake: { kind: "cancel" },
            now: at(2_000),
          });
          return {
            released,
            late,
            schedule: yield* executions.findSchedule(executionId),
          };
        })
      );

      expect(result.released.schedule.state).toBe("waiting");
      expect(result.late).toEqual({ resolved: false, requeued: false });
      expect(result.schedule).toMatchObject({
        state: "waiting",
        wakeAt: at(120_000),
      });
    });

    it("repins a sleeping run and re-queues it with a migrate wake on every park, in the repin's own write", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;

          /** A run parked on two Waits, whose pass has released it to sleep. */
          const sleepingRun = Effect.gen(function* () {
            const executionId = yield* scheduledRun(T0);
            const { fence } = yield* claimRun(executionId, T0);
            const first = yield* park(executionId, "wait_a", at(90_000));
            const second = yield* park(executionId, "wait_b", at(120_000));
            yield* executions
              .fenced(fence)
              .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
            return { executionId, parks: [first, second] };
          });
          const repin = (
            run: { executionId: string; parks: string[] },
            parks: RepinParks
          ) =>
            Effect.gen(function* () {
              const moved = yield* executions.repinVersion({
                executionId: run.executionId,
                fromVersionId: "ver_1",
                toVersionId: "ver_2",
                expectedWaitStates: yield* executions.listWaitingStates(
                  run.executionId
                ),
                parks,
              });
              return {
                moved,
                version: (yield* executions.findSummaryById(run.executionId))
                  ?.workflowVersionId,
                parks: yield* Effect.forEach(run.parks, (waitStateId) =>
                  executions.findPark(waitStateId)
                ),
                schedule: yield* executions.findSchedule(run.executionId),
              };
            });

          return {
            requeued: yield* repin(yield* sleepingRun, {
              kind: "requeue",
              now: at(5_000),
            }),
            leftParked: yield* repin(yield* sleepingRun, {
              kind: "leave_parked",
            }),
          };
        })
      );

      expect(result.requeued).toMatchObject({
        moved: true,
        version: "ver_2",
        schedule: { state: "queued", wakeAt: at(5_000) },
      });
      expect(result.requeued.parks).toMatchObject([
        { status: "resuming", wake: { kind: "migrate" } },
        { status: "resuming", wake: { kind: "migrate" } },
      ]);
      // A caller that signals the parks itself gets the pointer moved alone.
      expect(result.leftParked).toMatchObject({
        moved: true,
        version: "ver_2",
        schedule: { state: "waiting", wakeAt: at(90_000) },
      });
      expect(result.leftParked.parks).toMatchObject([
        { status: "waiting", wake: null },
        { status: "waiting", wake: null },
      ]);
    });

    it("leaves a leased run's schedule row to its release when a repin re-queues it, and the release queues the run", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const parked = yield* park(executionId, "wait_a", at(90_000));

          // The Migration lands while the pass that parked the Wait still
          // holds the lease.
          const moved = yield* executions.repinVersion({
            executionId,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates:
              yield* executions.listWaitingStates(executionId),
            parks: { kind: "requeue", now: at(500) },
          });
          const duringPass = yield* executions.findSchedule(executionId);
          const released = yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          return {
            moved,
            duringPass,
            park: yield* executions.findPark(parked),
            released,
          };
        })
      );

      expect(result.moved).toBe(true);
      expect(result.duringPass).toMatchObject({
        state: "leased",
        ownerToken: expect.any(String),
      });
      expect(result.park).toMatchObject({
        status: "resuming",
        wake: { kind: "migrate" },
      });
      expect(result.released.schedule).toEqual({
        state: "queued",
        wakeAt: at(1_000),
        attempt: 0,
      });
    });

    // The TLA+ Migration model's `RepinNeedsAPark` guard: a run that is
    // running, or that holds a Wait an Event already woke, keeps the version
    // its work below that Wait runs under.
    it("refuses to repin with a re-queue a run that is running or holds a woken Wait, writing nothing", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          yield* publishSecondVersion;
          const repin = (executionId: string) =>
            Effect.gen(function* () {
              return yield* executions.repinVersion({
                executionId,
                fromVersionId: "ver_1",
                toVersionId: "ver_2",
                expectedWaitStates:
                  yield* executions.listWaitingStates(executionId),
                parks: { kind: "requeue", now: at(5_000) },
              });
            });

          const running = yield* scheduledRun(T0);
          const runningRefused = yield* repin(running);
          const runningSchedule = yield* executions.findSchedule(running);

          const woken = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(woken, T0);
          const eventPark = yield* park(woken, "wait_a", at(90_000));
          const otherPark = yield* park(woken, "wait_b", at(120_000));
          yield* executions
            .fenced(fence)
            .releasePass({ outcome: { kind: "parked" }, now: at(1_000) });
          // The Migration classified both parks before the Event arrived.
          const classified = yield* executions.listWaitingStates(woken);
          yield* executions.resolvePark({
            executionId: woken,
            waitStateId: eventPark,
            wake: {
              kind: "resume",
              eventName: "appointment/approved",
              payload: {},
              deliveryId: "delivery_1",
            },
            now: at(2_000),
          });
          const wokenRefused = yield* executions.repinVersion({
            executionId: woken,
            fromVersionId: "ver_1",
            toVersionId: "ver_2",
            expectedWaitStates: classified,
            parks: { kind: "requeue", now: at(5_000) },
          });

          return {
            runningRefused,
            runningVersion: (yield* executions.findSummaryById(running))
              ?.workflowVersionId,
            runningSchedule,
            wokenRefused,
            wokenVersion: (yield* executions.findSummaryById(woken))
              ?.workflowVersionId,
            eventPark: yield* executions.findPark(eventPark),
            otherPark: yield* executions.findPark(otherPark),
            wokenSchedule: yield* executions.findSchedule(woken),
          };
        })
      );

      expect(result.runningRefused).toBe(false);
      expect(result.runningVersion).toBe("ver_1");
      expect(result.runningSchedule).toMatchObject({
        state: "queued",
        wakeAt: T0,
      });
      expect(result.wokenRefused).toBe(false);
      expect(result.wokenVersion).toBe("ver_1");
      expect(result.eventPark).toMatchObject({
        status: "resuming",
        wake: { kind: "resume" },
      });
      expect(result.otherPark).toMatchObject({ status: "waiting", wake: null });
      expect(result.wokenSchedule).toMatchObject({
        state: "queued",
        wakeAt: at(2_000),
      });
    });
  });
}
