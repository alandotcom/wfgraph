/**
 * What the schedule, fencing and producer conformance cases share: a fixed
 * clock, and the start, claim and park of a run against the seeded workflow.
 */

import { Effect } from "effect";
import { compact, sortBy } from "es-toolkit/array";
import type { JsonValue } from "@wfgraph/shared/types/json";
import {
  type ClaimedRun,
  type DeliveryFence,
  ExecutionRepo,
  type RunFence,
} from "#src/backend/services/executions/repo";
import {
  type CaseDatabase,
  type ConformanceConnection,
  notYetDue,
  seedPublishedWorkflow,
} from "#src/backend/persistence/conformance/support";

export const T0 = new Date("2026-03-01T09:00:00.000Z");
export const LEASE_MS = 60_000;

export function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** The `olderThan` cutoff the retention sweep cases pass: an hour after `T0`. */
export const RETENTION_CUTOFF = at(3_600_000);

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

/**
 * Every cron timer row of `workflowId`, earliest `wake_at` first, as
 * `findSchedule` reads each one. No repository method lists them, so the ids
 * come from a query outside the repositories.
 */
export function cronTimers(
  database: Pick<CaseDatabase, "selectIds">,
  workflowId: string
) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const ids = yield* Effect.promise(() =>
      database.selectIds(
        `select id from workflow_execution_schedule where kind = 'cron' and workflow_id = '${workflowId}'`
      )
    );
    const rows = yield* Effect.forEach(ids, (scheduleId) =>
      executions.findSchedule({ scheduleId })
    );
    return sortBy(compact(rows), [
      (row) => row.wakeAt.getTime(),
      (row) => row.id,
    ]);
  });
}

/**
 * Leases one schedule row to a worker under `ownerToken`, standing in for the
 * claim. The lease outlasts every instant a case claims at, so no claim
 * sweeps it as expired.
 */
export function leaseScheduleRow(
  database: CaseDatabase,
  scheduleId: string,
  ownerToken: string
): Promise<void> {
  const update = `update workflow_execution_schedule set state = 'leased', owner_token = '${ownerToken}', worker_id = 'worker_1', lease_expires_at =`;
  const row = `where id = '${scheduleId}'`;
  return database.execute({
    postgresql: `${update} '${notYetDue.now.toISOString()}' ${row}`,
    sqlite: `${update} ${notYetDue.now.getTime()} ${row}`,
  });
}

/**
 * Leases a delivery's schedule row under `ownerToken`, standing in for the
 * claim, and answers the fence a pass holding that lease carries.
 */
export async function leaseDelivery(
  database: CaseDatabase,
  delivery: { inboxId: string; scheduleId: string },
  ownerToken: string
): Promise<DeliveryFence> {
  await leaseScheduleRow(database, delivery.scheduleId, ownerToken);
  return { kind: "delivery", ...delivery, ownerToken };
}

/** Opens one run that no claim in these cases leases, and answers its id. */
export const openRun = scheduledRun(notYetDue.now);

/** Claims every due row at `now` and answers the one for `executionId`. */
export function claimRun(executionId: string, now: Date) {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const claimed = yield* executions.claimDue({
      lanes: [{ kind: "run", limit: 10 }],
      workerId: "worker_1",
      leaseMs: LEASE_MS,
      now,
    });
    const own = claimed.find(
      (row): row is ClaimedRun =>
        row.kind === "run" && row.executionId === executionId
    );
    if (!own) throw new Error("The run was not claimed");
    const fence: RunFence = {
      kind: "run",
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
        lanes: [{ kind: "run", limit: 1 }],
        workerId,
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

/**
 * A step memo write as these cases make one: for a step of no node unless
 * `nodeId` names one.
 */
export function memoWrite(input: {
  stepId: string;
  value: JsonValue;
  leaseExpiresAt: Date;
  nodeId?: string | null | undefined;
}) {
  return { ...input, nodeId: input.nodeId ?? null };
}
