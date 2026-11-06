/**
 * What the schedule, fencing and producer conformance cases share: a fixed
 * clock, and the start, claim and park of a run against the seeded workflow.
 */

import { Effect } from "effect";
import {
  type ClaimedRun,
  ExecutionRepo,
  type RunFence,
} from "#src/backend/services/executions/repo";
import {
  type ConformanceConnection,
  notYetDue,
  seedPublishedWorkflow,
} from "#src/backend/persistence/conformance/support";

export const T0 = new Date("2026-03-01T09:00:00.000Z");
export const LEASE_MS = 60_000;

export function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/**
 * Opens one run against the seeded workflow, with its schedule row due at
 * `wakeAt`, and answers its id.
 */
export function scheduledRun(wakeAt: Date) {
  return Effect.gen(function* () {
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
      startedEntry: notYetDue.startedEntry,
      now: wakeAt,
    });
    if (started.status !== "started") throw new Error("Start was refused");
    return started.execution.id;
  });
}

/** Opens one run that no claim in these cases leases, and answers its id. */
export const openRun = scheduledRun(notYetDue.now);

/** Claims every due row at `now` and answers the one for `executionId`. */
export function claimRun(executionId: string, now: Date) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const claimed = yield* executions.claimDue({
      kind: "run",
      workerId: "worker_1",
      limit: 10,
      leaseMs: LEASE_MS,
      now,
    });
    const own = claimed.find(
      (row): row is ClaimedRun =>
        row.kind === "run" && row.executionId === executionId
    );
    if (!own) throw new Error("The run was not claimed");
    const fence: RunFence = {
      scheduleId: own.scheduleId,
      executionId,
      ownerToken: own.ownerToken,
    };
    return { claim: own, fence };
  });
}

/** Parks the run on one event Wait whose deadline is `waitUntil`. */
export function park(executionId: string, nodeId: string, waitUntil: Date) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const wait = yield* executions.startWait({
      side: "started",
      executionId,
      workflowId: "wf_1",
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
export function claimOne(connection: ConformanceConnection, workerId: string) {
  return connection.run(
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      return yield* executions.claimDue({
        kind: "run",
        workerId,
        limit: 1,
        leaseMs: LEASE_MS,
        now: at(5_000),
      });
    })
  );
}

/** The tag of the failure a write answers, for a write the case expects refused. */
export function refusalOf<A>(write: Effect.Effect<A, { _tag: string }>) {
  return Effect.flip(write).pipe(Effect.map((failure) => failure._tag));
}

export async function seeded(connection: ConformanceConnection) {
  await seedPublishedWorkflow(connection);
  return connection;
}
