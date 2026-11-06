/**
 * What the database executor is doing about an open run, decided once for
 * both backends: `executorActivityOf` classifies the facts the executor-state
 * reads answer, and the builders below are the parts of those reads that do
 * not depend on the dialect, so each backend keeps its FROM, WHERE and decoding.
 */

import {
  and,
  type Column,
  eq,
  inArray,
  isNotNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { Schema } from "effect";
import { maxBy, orderBy } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import { PARK_WAKE_KINDS } from "@wfgraph/shared/lifecycle/execution-schedule";
import { readAs } from "@wfgraph/shared/types/schema";
import type {
  ExecutionSchedule,
  ExecutorActivity,
  ExecutorHold,
  FailingStep,
  ParkWake,
  UnconsumedWake,
} from "#src/backend/services/executions/repo/contracts";

/**
 * What the executor is doing about one run at `now`, as `ExecutorActivity`
 * describes each case, taking the first that holds:
 *
 * 1. an unconsumed wake is `resuming`, naming the oldest when there are several;
 * 2. a lease that ended at or before `now` is `lease_expired`, the same test a
 *    claim sweeps it by, and a lease still held is `running`;
 * 3. a `queued` row not yet due after a step's failure is `retrying` that
 *    step, the one with the most failures when several are failing, and after
 *    a failure of the run body (`attempt` above zero) it is `retrying` with no
 *    node;
 * 4. a `queued` or `waiting` row due at or before `now` is `unclaimed`;
 * 5. a `waiting` row not yet due is `waiting`.
 *
 * A `queued` row not yet due with no failure has no activity, which answers
 * null. `wakes` is empty for a caller that did not read them.
 */
export function executorActivityOf(input: {
  hold: ExecutorHold;
  wakes: readonly UnconsumedWake[];
  now: Date;
}): ExecutorActivity | null {
  const { hold, now } = input;
  const at = now.getTime();
  const [wake] = input.wakes;
  if (wake !== undefined) {
    return {
      kind: "resuming",
      nodeId: wake.nodeId,
      nodeName: wake.nodeName,
      wake: wake.kind,
      eventName: wake.eventName,
      wokenAt: wake.wokenAt,
      deadline: wake.deadline,
      unclaimedSince:
        hold.state === "leased" ? null : (wake.wokenAt ?? hold.wakeAt),
    };
  }
  if (hold.state === "leased") {
    return hold.leaseExpiresAt !== null && hold.leaseExpiresAt.getTime() <= at
      ? {
          kind: "lease_expired",
          nodeId: hold.runningNodeId,
          nodeName: hold.runningNodeName,
          since: hold.leaseExpiresAt,
        }
      : {
          kind: "running",
          nodeId: hold.runningNodeId,
          nodeName: hold.runningNodeName,
          workerId: hold.workerId,
        };
  }
  const due = hold.wakeAt.getTime() <= at;
  if (hold.state === "queued" && !due) {
    const failing = maxBy(hold.failingSteps, (step) => step.failures);
    if (failing !== undefined) {
      return {
        kind: "retrying",
        nodeId: failing.nodeId,
        nodeName: failing.nodeName,
        nextTryAt: hold.wakeAt,
        failures: failing.failures,
        error: failing.error,
      };
    }
    return hold.attempt > 0
      ? {
          kind: "retrying",
          nodeId: null,
          nodeName: null,
          nextTryAt: hold.wakeAt,
          failures: hold.attempt,
          error: hold.lastError,
        }
      : null;
  }
  return due
    ? { kind: "unclaimed", dueSince: hold.wakeAt }
    : { kind: "waiting" };
}

/** A `failing` memo row as `failingStepFields` selects it. */
type FailingStepRow = Omit<FailingStep, "error"> & {
  scheduleId: string;
  error: string | null;
};

/**
 * One `ExecutorHold` per run among `schedules`, keyed by execution id, with
 * each run's failing steps from `failing` most failures first. A schedule row
 * that runs no Execution, which is a delivery's, is left out.
 */
export function executorHolds(
  schedules: ReadonlyArray<{
    schedule: ExecutionSchedule;
    runningNodeName: string | null;
  }>,
  failing: readonly FailingStepRow[]
): Map<string, ExecutorHold> {
  const bySchedule = Map.groupBy(
    orderBy(failing, ["failures", "stepId"], ["desc", "asc"]),
    (row) => row.scheduleId
  );
  return new Map(
    schedules.flatMap(({ schedule, runningNodeName }) =>
      schedule.executionId === null
        ? []
        : [
            [
              schedule.executionId,
              {
                state: schedule.state,
                wakeAt: schedule.wakeAt,
                attempt: schedule.attempt,
                runningStepId: schedule.runningStepId,
                runningNodeId: schedule.runningNodeId,
                runningNodeName,
                leaseExpiresAt: schedule.leaseExpiresAt,
                workerId: schedule.workerId,
                lastError: schedule.lastError,
                failingSteps: (bySchedule.get(schedule.id) ?? []).map((row) =>
                  failingStepOf(omit(row, ["scheduleId"]))
                ),
              },
            ] as const,
          ]
    )
  );
}

/**
 * A `failing` memo row's columns with the error narrowed to a string. The
 * table's check keeps a failing row's error set, so a row without one is a
 * defect.
 */
function failingStepOf<Row extends { error: string | null }>(
  row: Row
): Omit<Row, "error"> & { error: string } {
  if (row.error === null) {
    throw new Error("A failing step memo row holds no error");
  }
  return { ...row, error: row.error };
}

const readParkWakeKind = readAs(Schema.Literals(PARK_WAKE_KINDS));

/** A wake's `kind` as the JSON column holds it. The producers write only these. */
export function parkWakeKind(kind: string | null): ParkWake["kind"] {
  const known = readParkWakeKind(kind);
  if (known === undefined) {
    throw new Error("A wait row holds a wake of no known kind");
  }
  return known;
}

/** The `workflow_execution_logs` columns a node's name is read from. */
type LogColumns = { executionId: Column; nodeId: Column; nodeName: Column };

/**
 * Joins the log row that names a node: the row of the run `executionId` for
 * the node `nodeId`. A node with no log row yet joins none.
 */
export function logOfNode(
  log: LogColumns,
  executionId: Column,
  nodeId: Column
) {
  return and(eq(log.executionId, executionId), eq(log.nodeId, nodeId));
}

/** The `workflow_execution_steps` columns the reads select and filter on. */
type StepColumns = {
  scheduleId: Column;
  stepId: Column;
  nodeId: Column;
  status: Column;
  failures: Column;
  error: Column;
};

/** The select map of a failing step, its node named by `failingLog`. */
export function failingStepFields<
  Steps extends StepColumns,
  Log extends LogColumns,
>(
  steps: Steps,
  failingLog: Log
): {
  scheduleId: Steps["scheduleId"];
  stepId: Steps["stepId"];
  nodeId: Steps["nodeId"];
  nodeName: Log["nodeName"];
  failures: Steps["failures"];
  error: Steps["error"];
} {
  return {
    scheduleId: steps.scheduleId,
    stepId: steps.stepId,
    nodeId: steps.nodeId,
    nodeName: failingLog.nodeName,
    failures: steps.failures,
    error: steps.error,
  };
}

/** The memo rows of `scheduleIds` that are `failing`. */
export function failingStepsOf(
  steps: StepColumns,
  scheduleIds: readonly string[]
) {
  return and(
    inArray(steps.scheduleId, [...scheduleIds]),
    eq(steps.status, "failing")
  );
}

/** The `workflow_wait_states` columns the wake read selects and filters on. */
type WaitColumns = {
  id: Column;
  executionId: Column;
  nodeId: Column;
  nodeName: Column;
  status: Column;
  wake: Column;
  resumedAt: Column;
  waitUntil: Column;
};

/**
 * The select map of an unconsumed wake. The wake's payload is an arbitrary
 * Event body, so only the two fields the view names are read out of it.
 */
export function unconsumedWakeFields<Waits extends WaitColumns>(
  waits: Waits
): {
  waitStateId: Waits["id"];
  nodeId: Waits["nodeId"];
  nodeName: Waits["nodeName"];
  kind: SQL<string | null>;
  eventName: SQL<string | null>;
  wokenAt: Waits["resumedAt"];
  deadline: Waits["waitUntil"];
} {
  return {
    waitStateId: waits.id,
    nodeId: waits.nodeId,
    nodeName: waits.nodeName,
    kind: sql<string | null>`${waits.wake} ->> 'kind'`,
    eventName: sql<string | null>`${waits.wake} ->> 'eventName'`,
    wokenAt: waits.resumedAt,
    deadline: waits.waitUntil,
  };
}

/** The wait rows of `executionId` holding a wake no pass has consumed. */
export function unconsumedWakesOf(waits: WaitColumns, executionId: string) {
  return and(
    eq(waits.executionId, executionId),
    eq(waits.status, "resuming"),
    isNotNull(waits.wake)
  );
}
