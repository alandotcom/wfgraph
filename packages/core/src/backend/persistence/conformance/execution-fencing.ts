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
import { sortBy } from "es-toolkit/array";
import {
  ExecutionRepo,
  type FencedExecutionWrites,
} from "#src/backend/services/executions/repo";
import {
  type CloseNodeLogInput,
  nodeLogId,
} from "#src/backend/services/executions/repo/node-logs";
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

/**
 * The fenced close transitions, one node each: the close the row gets first,
 * if any, and the close that follows it.
 */
const CLOSE_TRANSITIONS: readonly {
  nodeId: string;
  first?: CloseNodeLogInput["status"] | undefined;
  second: CloseNodeLogInput["status"];
}[] = [
  { nodeId: "running_to_success", second: "success" },
  { nodeId: "running_to_error", second: "error" },
  { nodeId: "error_to_success", first: "error", second: "success" },
  { nodeId: "error_to_error", first: "error", second: "error" },
  { nodeId: "success_to_error", first: "success", second: "error" },
  { nodeId: "success_to_success", first: "success", second: "success" },
];

/** The close of the row `logId` with `status` that attempt `attempt` makes. */
function closeInput(input: {
  logId: string;
  status: CloseNodeLogInput["status"];
  attempt: number;
}): CloseNodeLogInput {
  const { logId, status, attempt } = input;
  return {
    logId,
    status,
    output: status === "success" ? { attempt } : undefined,
    error: status === "error" ? `attempt ${attempt}` : undefined,
    durationMs: attempt,
  };
}

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

    // Each row is opened and given its first close, then the node's step
    // fails once, then the row's second close runs. A close that applies
    // writes the row's outcome and reads the failure into `retries`; a close
    // the fence's guard refuses leaves the row as the first close wrote it.
    it("applies a fenced close to a running row, and to an error row only when it reports success", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          let clock = 0;
          const pass = Effect.gen(function* () {
            const { fence } = yield* claimRun(executionId, at(clock));
            return executions.fenced(fence);
          });
          const close = (
            writes: FencedExecutionWrites,
            nodeId: string,
            status: CloseNodeLogInput["status"],
            attempt: number
          ) =>
            writes.closeNodeLog(
              closeInput({
                logId: nodeLogId(executionId, nodeId),
                status,
                attempt,
              })
            );

          let current = yield* pass;
          for (const { nodeId, first } of CLOSE_TRANSITIONS) {
            yield* current.openNodeLog({
              executionId,
              nodeId,
              nodeName: nodeId,
              nodeType: "action",
            });
            if (first !== undefined) {
              yield* close(current, nodeId, first, 1);
            }
          }
          for (const { nodeId } of CLOSE_TRANSITIONS) {
            const released = yield* current.releasePass({
              outcome: {
                kind: "step_failed",
                stepId: `node:${nodeId}:dispatch`,
                nodeId,
                error: "vendor timed out",
                backoffMs: 0,
              },
              now: at(clock),
            });
            clock = released.schedule.wakeAt.getTime() - T0.getTime() + 1;
            current = yield* pass;
          }
          for (const { nodeId, second } of CLOSE_TRANSITIONS) {
            yield* close(current, nodeId, second, 2);
          }
          const logs = yield* executions.listLogs(executionId);
          return logs.map((log) => ({
            nodeId: log.nodeId,
            status: log.status,
            output: log.output,
            error: log.error,
            duration: log.duration,
            retries: log.retries,
          }));
        })
      );

      // Only `running` to either status and `error` to `success` apply. An
      // applied close writes the second attempt's outcome and reads the
      // node's failure into `retries`; a refused one leaves the first close.
      expect(sortBy(result, [(log) => log.nodeId])).toEqual([
        {
          nodeId: "error_to_error",
          status: "error",
          output: null,
          error: "attempt 1",
          duration: "1",
          retries: 0,
        },
        {
          nodeId: "error_to_success",
          status: "success",
          output: { attempt: 2 },
          error: null,
          duration: "2",
          retries: 1,
        },
        {
          nodeId: "running_to_error",
          status: "error",
          output: null,
          error: "attempt 2",
          duration: "2",
          retries: 1,
        },
        {
          nodeId: "running_to_success",
          status: "success",
          output: { attempt: 2 },
          error: null,
          duration: "2",
          retries: 1,
        },
        {
          nodeId: "success_to_error",
          status: "success",
          output: { attempt: 1 },
          error: null,
          duration: "1",
          retries: 0,
        },
        {
          nodeId: "success_to_success",
          status: "success",
          output: { attempt: 1 },
          error: null,
          duration: "1",
          retries: 0,
        },
      ]);
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

      expect(result.cancelled).toEqual({ kind: "ended", status: "canceled" });
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
    // write is held to that by the run-ending table in `execution-run-endings.ts`; a run
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
