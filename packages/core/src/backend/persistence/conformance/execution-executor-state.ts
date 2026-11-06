/**
 * The executions aggregate's reads of the database executor for the Runs
 * view: where the executor holds one open run (`findExecutorState`), and where
 * it holds each run on a runs list page (`listExecutorHolds`).
 *
 * Every case passes its own clock to the claim, the release and the read, so
 * the due and lease comparisons do not depend on how fast the case runs.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { sortBy } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { executorActivityOf } from "#src/backend/services/executions/repo/executor-activity";
import type { PersistenceTestRegistry } from "#src/backend/persistence/conformance/support";
import {
  T0,
  LEASE_MS,
  at,
  scheduledRun,
  claimRun,
  park,
  seeded,
} from "#src/backend/persistence/conformance/schedule-support";

const BACKOFF_MS = 120_000;

/** Opens the run's log row for one node, which names the node. */
function openLog(executionId: string, nodeId: string, nodeName: string) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    return yield* executions.openNodeLog({
      executionId,
      nodeId,
      nodeName,
      nodeType: "action",
    });
  });
}

export function describeExecutionExecutorStateConformance({
  openConnection,
}: PersistenceTestRegistry): void {
  describe("execution executor state reads", () => {
    it("reads where the executor holds an open run, and nothing once the run ends", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const queued = yield* executions.findExecutorState(executionId);
          // Node `send` has opened its log row and node `notify` has not.
          yield* openLog(executionId, "send", "Send reminder");

          // A pass running a step of node `send`.
          const { fence } = yield* claimRun(executionId, T0);
          const live = executions.fenced(fence);
          yield* live.renewLease({
            leaseExpiresAt: at(LEASE_MS),
            runningStepId: "node:send:dispatch",
            runningNodeId: "send",
          });
          const leased = yield* executions.findExecutorState(executionId);

          // Two steps fail, one of them twice, and the run waits out its
          // backoff.
          let clock = 1_000;
          const fail = (stepId: string, nodeId: string) =>
            Effect.gen(function* () {
              const { fence: failing } = yield* claimRun(
                executionId,
                at(clock)
              );
              const released = yield* executions.fenced(failing).releasePass({
                outcome: {
                  kind: "step_failed",
                  stepId,
                  nodeId,
                  error: `${nodeId} is down`,
                  backoffMs: 0,
                },
                now: at(clock),
              });
              clock = released.schedule.wakeAt.getTime() - T0.getTime() + 1;
            });
          yield* live.releasePass({
            outcome: {
              kind: "step_failed",
              stepId: "node:send:dispatch",
              nodeId: "send",
              error: "send is down",
              backoffMs: 0,
            },
            now: at(clock),
          });
          yield* fail("node:send:dispatch", "send");
          yield* fail("node:notify:dispatch", "notify");
          const retrying = yield* executions.findExecutorState(executionId);

          // Two Waits park; an Event claims one and a deadline passes on the
          // other, and no pass has read either wake yet.
          const { fence: parking } = yield* claimRun(executionId, at(clock));
          yield* park(executionId, "approval", at(clock + 90_000));
          const delayed = yield* park(executionId, "pause", at(clock + 5_000));
          yield* executions.fenced(parking).releasePass({
            outcome: { kind: "parked" },
            now: at(clock),
          });
          yield* executions.claimWaitingStateByToken({
            resumeToken: `${executionId}-approval`,
            arrival: {
              eventName: "app/approved",
              payload: { approvedBy: "ops" },
            },
            now: at(clock + 1_000),
          });
          yield* executions.wakePark({
            executionId,
            waitStateId: delayed,
            wake: { kind: "timeout" },
            now: at(clock + 2_000),
          });
          const woken = yield* executions.findExecutorState(executionId);

          const { fence: last } = yield* claimRun(
            executionId,
            at(clock + 3_000)
          );
          yield* executions
            .fenced(last)
            .finishRun({ executionId, status: "completed" });
          return {
            queued,
            leased,
            retrying,
            woken,
            ended: yield* executions.findExecutorState(executionId),
            unknown: yield* executions.findExecutorState("exec_missing"),
            wokenAt: at(clock + 1_000),
            approvalDeadline: at(clock + 90_000),
            pauseDeadline: at(clock + 5_000),
          };
        })
      );

      expect(result.queued).toEqual({
        state: "queued",
        wakeAt: T0,
        attempt: 0,
        runningStepId: null,
        runningNodeId: null,
        runningNodeName: null,
        leaseExpiresAt: null,
        workerId: null,
        lastError: null,
        failingSteps: [],
        unconsumedWakes: [],
      });
      expect(result.leased).toMatchObject({
        state: "leased",
        runningStepId: "node:send:dispatch",
        runningNodeId: "send",
        runningNodeName: "Send reminder",
        leaseExpiresAt: at(LEASE_MS),
        workerId: "worker_1",
      });
      // The step with the most failures comes first.
      expect(result.retrying).toMatchObject({
        state: "queued",
        lastError: "notify is down",
        runningStepId: null,
        failingSteps: [
          {
            stepId: "node:send:dispatch",
            nodeId: "send",
            nodeName: "Send reminder",
            failures: 2,
            error: "send is down",
          },
          {
            stepId: "node:notify:dispatch",
            nodeId: "notify",
            nodeName: null,
            failures: 1,
            error: "notify is down",
          },
        ],
        unconsumedWakes: [],
      });
      // Only an Event or a manual resume records when it claimed the park.
      expect(result.woken?.state).toBe("queued");
      // Two parks opened in one millisecond tie on their creation time, so
      // the wakes are compared in node order.
      expect(
        sortBy(
          (result.woken?.unconsumedWakes ?? []).map((wake) =>
            omit(wake, ["waitStateId"])
          ),
          [(wake) => wake.nodeId]
        )
      ).toEqual([
        {
          nodeId: "approval",
          nodeName: "approval",
          kind: "resume",
          eventName: "app/approved",
          wokenAt: result.wokenAt,
          deadline: result.approvalDeadline,
        },
        {
          nodeId: "pause",
          nodeName: "pause",
          kind: "timeout",
          eventName: null,
          wokenAt: null,
          deadline: result.pauseDeadline,
        },
      ]);
      expect(result.ended).toBeNull();
      expect(result.unknown).toBeNull();
    });

    // A worker claimed the run after an Event resolved its park, then died
    // before its pass read the wake. The wake and the expired lease are both
    // on the run, and the expired lease is what the overview says.
    it("reads a wake behind an expired lease as the expired lease", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const executionId = yield* scheduledRun(T0);
          const { fence: parking } = yield* claimRun(executionId, T0);
          yield* park(executionId, "approval", at(600_000));
          yield* executions.fenced(parking).releasePass({
            outcome: { kind: "parked" },
            now: at(1_000),
          });
          yield* executions.claimWaitingStateByToken({
            resumeToken: `${executionId}-approval`,
            arrival: { eventName: "app/approved", payload: {} },
            now: at(2_000),
          });
          yield* claimRun(executionId, at(3_000));
          return yield* executions.findExecutorState(executionId);
        })
      );

      expect(result).toMatchObject({
        state: "leased",
        leaseExpiresAt: at(3_000 + LEASE_MS),
        unconsumedWakes: [{ nodeId: "approval", kind: "resume" }],
      });
      expect(
        result === null
          ? null
          : executorActivityOf({
              hold: result,
              wakes: result.unconsumedWakes,
              now: at(3_000 + LEASE_MS + 1),
            })
      ).toEqual({
        kind: "lease_expired",
        nodeId: null,
        nodeName: null,
        since: at(3_000 + LEASE_MS),
      });
    });

    it("names each node of one run with a failing step once, and none once the run ends", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          /** Claims `executionId` and counts one failure on `stepId`. */
          const fail = (
            executionId: string,
            stepId: string,
            nodeId: string | null
          ) =>
            Effect.gen(function* () {
              const { fence } = yield* claimRun(executionId, at(10_000));
              yield* executions.fenced(fence).releasePass({
                outcome: {
                  kind: "step_failed",
                  stepId,
                  nodeId,
                  error: "down",
                  backoffMs: 0,
                },
                now: T0,
              });
            });

          // Two failing steps of `fetch` and one of no node; the other run's
          // failing step is not this run's.
          const retrying = yield* scheduledRun(T0);
          yield* fail(retrying, "node:fetch:read", "fetch");
          yield* fail(retrying, "node:fetch:write", "fetch");
          yield* fail(retrying, "lifecycle-read", null);
          const other = yield* scheduledRun(T0);
          yield* fail(other, "node:send:dispatch", "send");

          const failingNodes = yield* executions.listFailingNodeIds(retrying);
          const { fence } = yield* claimRun(other, at(10_000));
          yield* executions
            .fenced(fence)
            .finishRun({ executionId: other, status: "failed" });
          return {
            failingNodes,
            ended: yield* executions.listFailingNodeIds(other),
          };
        })
      );

      expect(result.failingNodes).toEqual(["fetch"]);
      expect(result.ended).toEqual([]);
    });

    it("reads where the executor holds each run on a list page in one call", async () => {
      const connection = await seeded(await openConnection());
      const result = await connection.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          // Each run is opened and claimed before the next is opened, so a
          // claim leases only the run it was made for.
          const leaseExpired = yield* scheduledRun(T0);
          yield* openLog(leaseExpired, "slow", "Slow call");
          const { fence: expiring } = yield* claimRun(leaseExpired, T0);
          yield* executions.fenced(expiring).renewLease({
            leaseExpiresAt: at(LEASE_MS),
            runningStepId: "node:slow:dispatch",
            runningNodeId: "slow",
          });

          const stepRetry = yield* scheduledRun(T0);
          yield* openLog(stepRetry, "send", "Send reminder");
          const { fence: stepFence } = yield* claimRun(stepRetry, T0);
          yield* executions.fenced(stepFence).releasePass({
            outcome: {
              kind: "step_failed",
              stepId: "node:send:dispatch",
              nodeId: "send",
              error: "send is down",
              backoffMs: BACKOFF_MS,
            },
            now: at(1_000),
          });

          const bodyRetry = yield* scheduledRun(T0);
          const { fence: bodyFence } = yield* claimRun(bodyRetry, T0);
          yield* executions.fenced(bodyFence).releasePass({
            outcome: {
              kind: "body_failed",
              error: "the body failed outside any step",
              backoffMs: BACKOFF_MS,
            },
            now: at(1_000),
          });

          const asleep = yield* scheduledRun(T0);
          const { fence: asleepFence } = yield* claimRun(asleep, T0);
          yield* park(asleep, "wait_a", at(600_000));
          yield* executions.fenced(asleepFence).releasePass({
            outcome: { kind: "parked" },
            now: at(1_000),
          });

          const held = yield* scheduledRun(at(10_000));
          yield* claimRun(held, at(10_000));

          const ended = yield* scheduledRun(at(10_000));
          const { fence: endedFence } = yield* claimRun(ended, at(10_000));
          yield* executions
            .fenced(endedFence)
            .finishRun({ executionId: ended, status: "completed" });

          // Due, and no claim follows.
          const unclaimed = yield* scheduledRun(at(20_000));

          return {
            ids: {
              leaseExpired,
              stepRetry,
              bodyRetry,
              asleep,
              held,
              ended,
              unclaimed,
            },
            holds: yield* executions.listExecutorHolds([
              leaseExpired,
              stepRetry,
              bodyRetry,
              asleep,
              held,
              ended,
              unclaimed,
            ]),
            none: yield* executions.listExecutorHolds([]),
          };
        })
      );

      const { ids } = result;
      // The holds decide as the list service decides them, with no wakes.
      const activities = new Map(
        [...result.holds].map(([executionId, hold]) => [
          executionId,
          executorActivityOf({ hold, wakes: [], now: at(LEASE_MS + 5_000) }),
        ])
      );
      expect(activities).toEqual(
        new Map([
          [
            ids.leaseExpired,
            {
              kind: "lease_expired",
              nodeId: "slow",
              nodeName: "Slow call",
              since: at(LEASE_MS),
            },
          ],
          [
            ids.stepRetry,
            {
              kind: "retrying",
              nodeId: "send",
              nodeName: "Send reminder",
              nextTryAt: at(1_000 + BACKOFF_MS),
              failures: 1,
              error: "send is down",
            },
          ],
          [
            ids.bodyRetry,
            {
              kind: "retrying",
              nodeId: null,
              nodeName: null,
              nextTryAt: at(1_000 + BACKOFF_MS),
              failures: 1,
              error: "the body failed outside any step",
            },
          ],
          [ids.asleep, { kind: "waiting" }],
          [
            ids.held,
            {
              kind: "running",
              nodeId: null,
              nodeName: null,
              workerId: "worker_1",
            },
          ],
          [ids.unclaimed, { kind: "unclaimed", dueSince: at(20_000) }],
        ])
      );
      expect(result.none).toEqual(new Map());
    });
  });
}
