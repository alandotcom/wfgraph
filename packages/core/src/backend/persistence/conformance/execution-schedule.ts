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
} from "#src/backend/services/executions/repo";
import type {
  ConformanceConnection,
  PersistenceTestRegistry,
} from "#src/backend/persistence/conformance/support";
import { seedPublishedWorkflow } from "#src/backend/persistence/conformance/support";

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
    const fence: OwnerFence = { executionId, ownerToken: own.ownerToken };
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

    it("leases with a fresh token, and counts an attempt only for an expired lease", async () => {
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
              attempt: first.attempt,
              value: "stale",
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
      expect(result.staleWrite._tag).toBe("Conflict");
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
        state: "waiting",
        wakeAt: at(10_000),
        attempt: 0,
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
              .writeStepMemo({ stepId, attempt: 0, value });
          }
          return yield* executions.listStepMemo(executionId);
        })
      );

      expect(
        Object.fromEntries(memo.map((entry) => [entry.stepId, entry.value]))
      ).toEqual(values);
    });

    it("writes each release outcome", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          // Each run has already lost one lease, so its counter stands at one
          // and an outcome that leaves the counter alone can be told from one
          // that resets it.
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
            retry: yield* release({
              kind: "retry",
              error: "vendor timed out",
              backoffMs: 30_000,
            }),
            fenceRefused: yield* release({ kind: "fence_refused" }),
            retriesSpent: yield* release({
              kind: "retries_spent",
              stepId: "node:send:step",
              failure: { success: false, error: { message: "refused" } },
            }),
            nothingParked: yield* release({ kind: "parked" }),
          };
        })
      );

      const releasedAt = at(LEASE_MS + 1_000);
      expect(result.retry.released).toEqual({
        state: "queued",
        wakeAt: at(LEASE_MS + 31_000),
        attempt: 2,
      });
      expect(result.retry.schedule).toMatchObject({
        state: "queued",
        lastError: "vendor timed out",
        ownerToken: null,
        leaseExpiresAt: null,
        workerId: null,
      });
      expect(result.fenceRefused.released).toEqual({
        state: "queued",
        wakeAt: releasedAt,
        attempt: 1,
      });
      expect(result.retriesSpent.released).toEqual({
        state: "queued",
        wakeAt: releasedAt,
        attempt: 0,
      });
      expect(result.retriesSpent.memo).toEqual([
        {
          stepId: "node:send:step",
          attempt: 1,
          value: { success: false, error: { message: "refused" } },
        },
      ]);
      // A pass that ended parked with nothing waiting has nothing to sleep on.
      expect(result.nothingParked.released).toEqual({
        state: "queued",
        wakeAt: releasedAt,
        attempt: 1,
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
      expect(result.released).toEqual({
        state: "queued",
        wakeAt: at(1_000),
        attempt: 0,
      });
      expect(result.slept).toEqual({
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
          const { claim, fence } = yield* claimRun(executionId, T0);
          const waitStateId = yield* park(executionId, "wait_1", at(90_000));
          const live = executions.fenced(fence);
          yield* live.writeStepMemo({
            stepId: "node:a:log-open",
            attempt: claim.attempt,
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
            executionId,
            ownerToken: "not-a-token",
          });
          return {
            memo: yield* Effect.flip(
              stale.writeStepMemo({
                stepId: "node:b:log-open",
                attempt: 0,
                value: null,
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
            memoRows: yield* executions.listStepMemo(executionId),
            park: yield* executions.findPark(waitStateId),
            status: yield* executions.findStatusById(executionId),
            events: yield* executions.listEvents(executionId),
          };
        })
      );

      expect(result.memo._tag).toBe("Conflict");
      expect(result.markRunning._tag).toBe("Conflict");
      expect(result.finishRun._tag).toBe("Conflict");
      expect(result.audit._tag).toBe("Conflict");
      expect(result.memoRows).toEqual([
        { stepId: "node:a:log-open", attempt: 0, value: { logId: "log_a" } },
      ]);
      expect(result.park).toMatchObject({ parkStepId: "wait:1", wake: null });
      expect(result.status?.status).toBe("waiting");
      expect(result.events).toEqual([]);
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
            attempt: 0,
            value: { logId },
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
      expect(result.afterEnd._tag).toBe("Conflict");
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
      expect(result.released).toMatchObject({
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
  });
}
