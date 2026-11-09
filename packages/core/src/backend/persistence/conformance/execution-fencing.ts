/**
 * The executions aggregate's fenced writes: which writes a pass's owner fence
 * refuses once the pass no longer holds its schedule row, and what a fenced
 * write that re-runs leaves behind.
 *
 * Every case passes its own clock to the claim and the release, so the lease
 * comparisons do not depend on how fast the case runs.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import {
  type PersistenceTestRegistry,
  terminalEntry,
  verdict,
} from "#src/backend/persistence/conformance/support";
import {
  T0,
  LEASE_MS,
  at,
  scheduledRun,
  claimRun,
  park,
  refusalOf,
  seeded,
} from "#src/backend/persistence/conformance/schedule-support";

export function describeExecutionFencingConformance({
  openConnection,
}: PersistenceTestRegistry): void {
  describe("execution fenced writes", () => {
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
            nodeId: "a",
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
                nodeId: null,
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
            endRun: yield* Effect.flip(
              forged.endRun({ executionId, ending: verdict("completed") })
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
            memoRows: yield* executions.listStepMemo({ executionId }),
            park: yield* executions.findPark(waitStateId),
            status: yield* executions.findStatusById(executionId),
            events: yield* executions.listEvents(executionId),
            schedule: yield* executions.findSchedule({ executionId }),
          };
        })
      );

      expect(result.memo._tag).toBe("LeaseLost");
      expect(result.markRunning._tag).toBe("LeaseLost");
      expect(result.endRun._tag).toBe("LeaseLost");
      expect(result.audit._tag).toBe("LeaseLost");
      expect(result.dropped._tag).toBe("LeaseLost");
      expect(result.memoRows).toEqual([
        {
          stepId: "node:a:log-open",
          nodeId: "a",
          status: "succeeded",
          failures: 0,
          value: { logId: "log_a" },
        },
      ]);
      expect(result.park).toMatchObject({ parkStepId: "wait:1", wake: null });
      expect(result.status?.status).toBe("waiting");
      // The run's opening entry, and nothing the stale pass wrote.
      expect(result.events.map((event) => event.eventType)).toEqual([
        "run_started",
      ]);
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
      // Both waiting entries, newest first, ahead of the run's opening entry.
      expect(result.events.map((event) => event.eventType)).toEqual([
        "run_waiting",
        "run_waiting",
        "run_started",
      ]);
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

    it("refuses a leased pass's next write once a policy cancel ends its run", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          const pass = executions.fenced(fence);
          yield* pass.writeStepMemo({
            nodeId: null,
            stepId: "step_1",
            value: "sent",
            leaseExpiresAt: at(LEASE_MS),
          });
          const waitStateId = yield* park(executionId, "wait_open", at(90_000));
          const cancelled = yield* executions.cancelRun({
            executionId,
            reason: "Canceled by a Lifecycle Rule",
          });
          return {
            cancelled,
            staleMemo: yield* refusalOf(
              pass.writeStepMemo({
                nodeId: null,
                stepId: "step_2",
                value: "stale",
                leaseExpiresAt: at(LEASE_MS),
              })
            ),
            staleFinish: yield* refusalOf(
              pass.endRun({ executionId, ending: verdict("completed") })
            ),
            staleRelease: yield* refusalOf(
              pass.releasePass({ outcome: { kind: "parked" }, now: at(1_000) })
            ),
            schedule: yield* executions.findSchedule({ executionId }),
            memo: yield* executions.listStepMemo({ executionId }),
            park: yield* executions.findPark(waitStateId),
            status: yield* executions.findStatusById(executionId),
          };
        })
      );

      expect(result.cancelled).toMatchObject({
        status: "canceled",
        didWrite: true,
      });
      expect(result.staleMemo).toBe("LeaseLost");
      expect(result.staleFinish).toBe("LeaseLost");
      expect(result.staleRelease).toBe("LeaseLost");
      expect(result.schedule).toBeNull();
      expect(result.memo).toEqual([]);
      expect(result.park).toMatchObject({ status: "cancelled" });
      expect(result.status?.status).toBe("canceled");
    });

    // A count kept for the whole run would hand each later step the retries
    // its predecessors spent.

    // The Runs view formats a duration made of digits alone as milliseconds,
    // and prints any other string as it was stored.
    it("writes a finished run's duration as whole milliseconds", async () => {
      const connection = await seeded(await openConnection());
      const summary = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence } = yield* claimRun(executionId, T0);
          yield* executions
            .fenced(fence)
            .endRun({ executionId, ending: verdict("completed") });
          return yield* executions.findSummaryById(executionId);
        })
      );

      expect(summary?.duration).toMatch(/^\d+$/);
    });

    // The Runs view prints a run with no duration as a dash. Every run-ending
    // write is held to that by the run-ending table in `executions.ts`; a run
    // recorded already ended is the one that never passes through it.
    it("writes a zero duration on a run recorded already ended", async () => {
      const connection = await seeded(await openConnection());
      const duration = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const recorded = yield* executions.insertTerminal({
            workflowId: "wf_1",
            workflowVersionId: "ver_1",
            startSource: "manual",
            runMode: "live",
            input: {},
            status: "canceled",
            announcement: terminalEntry,
          });
          return (yield* executions.findSummaryById(recorded.id))?.duration;
        })
      );

      expect(duration).toBe("0");
    });

    it("refuses a fenced write that addresses a run the fence does not name", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          // The other run is leased to a pass of its own first.
          const otherId = yield* scheduledRun(T0);
          const { fence: otherFence } = yield* claimRun(otherId, T0);
          const ownId = yield* scheduledRun(T0);
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
            endRun: yield* refusalOf(
              pass.endRun({
                executionId: otherId,
                ending: verdict("completed"),
              })
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
              crossed.endRun({
                executionId: otherId,
                ending: verdict("completed"),
              })
            ),
            crossedMemo: yield* refusalOf(
              crossed.writeStepMemo({
                nodeId: null,
                stepId: "step_1",
                value: null,
                leaseExpiresAt: at(LEASE_MS),
              })
            ),
            other: yield* executions.findStatusById(otherId),
            otherLogs: yield* executions.listLogs(otherId),
            otherEvents: yield* executions.listEvents(otherId),
            otherSchedule: yield* executions.findSchedule({
              executionId: otherId,
            }),
            otherFence,
          };
        })
      );

      expect(result).toMatchObject({
        markRunning: "LeaseLost",
        endRun: "LeaseLost",
        openNodeLog: "LeaseLost",
        audit: "LeaseLost",
        crossedFinish: "LeaseLost",
        crossedMemo: "LeaseLost",
      });
      expect(result.other?.status).toBe("running");
      expect(result.otherLogs).toEqual([]);
      expect(result.otherEvents.map((event) => event.eventType)).toEqual([
        "run_started",
      ]);
      expect(result.otherSchedule).toMatchObject({
        state: "leased",
        ownerToken: result.otherFence.ownerToken,
      });
    });
  });
}
