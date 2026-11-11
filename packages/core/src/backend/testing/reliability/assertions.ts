import { expect } from "vitest";
import { sortBy } from "es-toolkit/array";
import { mapValues } from "es-toolkit/object";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { WorkflowWaitState } from "#src/backend/services/executions/repo";
import type { ReliabilityHost } from "#src/backend/testing/reliability/host";
import { eventually } from "#src/backend/testing/reliability/control";

/**
 * Waits until the Execution is durably suspended on exactly `count` Waits: see
 * `waitForSuspension`.
 */
export async function waitForParkedWaits(
  host: ReliabilityHost,
  executionId: string,
  count: number
) {
  return waitForSuspension(
    host,
    executionId,
    `${count} parked Waits`,
    (rows) => rows.length === count
  );
}

/**
 * Waits until the Execution is durably suspended on exactly the Wait nodes
 * `nodeIds`: see `waitForSuspension`.
 */
export async function waitForOpenWaits(
  host: ReliabilityHost,
  executionId: string,
  nodeIds: readonly string[]
) {
  const expected = nodeIds.toSorted();
  return waitForSuspension(
    host,
    executionId,
    `parked Waits at [${expected.join(", ")}]`,
    (rows) =>
      rows.length === expected.length &&
      rows
        .map((row) => row.nodeId)
        .toSorted()
        .every((nodeId, index) => nodeId === expected[index])
  );
}

/**
 * Waits until the run's schedule row is `waiting` and its open wait rows are
 * the ones `accept` expects, and answers those rows. A `waiting` schedule row
 * is a pass that released the run with every park written, so a wake sent
 * afterwards resolves a park the executor will read.
 */
async function waitForSuspension(
  host: ReliabilityHost,
  executionId: string,
  label: string,
  accept: (rows: WorkflowWaitState[]) => boolean
) {
  const observed = await eventually(
    `durable suspension on ${label}`,
    async () => ({
      schedule: await host.run(host.repo.findSchedule({ executionId })),
      waits: await host.run(host.repo.listWaitingStates(executionId)),
    }),
    ({ schedule, waits }) => schedule?.state === "waiting" && accept(waits)
  );
  return observed.waits;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** `value` with every ISO timestamp string replaced by one placeholder. */
function withoutTimestamps(value: JsonValue): JsonValue {
  if (typeof value === "string")
    return ISO_TIMESTAMP.test(value) ? "<timestamp>" : value;
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (value === null || typeof value !== "object") return value;
  return mapValues(value, withoutTimestamps);
}

/**
 * What one settled Execution did, in an order that does not depend on which
 * independent branch ran first: its status, the side effects the fixture action
 * recorded, each node's run-log rows with resolved input, output and status,
 * and the audit event types. Timestamps are replaced, because they differ
 * between hosts.
 */
export async function observeExecution(
  host: ReliabilityHost,
  executionId: string
) {
  const summary = await host.run(host.repo.findSummaryById(executionId));
  const logs = await host.run(host.repo.listLogs(executionId));
  const events = await host.run(host.repo.listEvents(executionId));
  const nodeLogs = logs.map((log) => ({
    nodeId: log.nodeId,
    status: log.status,
    input: withoutTimestamps(log.input),
    output: withoutTimestamps(log.output),
    error: log.error,
  }));
  return {
    status: summary?.status,
    sideEffects: host.ledger.map((entry) => entry.marker).toSorted(),
    nodeLogs: sortBy(nodeLogs, [(entry) => JSON.stringify(entry)]),
    auditEvents: events.map((event) => event.eventType).toSorted(),
  };
}
type ExecutionObservation = Awaited<ReturnType<typeof observeExecution>>;

/** How many run-log rows each node wrote, keyed by node id. */
export function nodeLogCounts(
  observation: ExecutionObservation
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of observation.nodeLogs)
    counts.set(entry.nodeId, (counts.get(entry.nodeId) ?? 0) + 1);
  return Object.fromEntries(counts);
}

/**
 * Waits until the workflow's one Execution reads `status` with its schedule row
 * and step memo deleted, which is the executor done with it, and until the
 * inbox row of every Event the case sent has settled. Then checks that each
 * one was delivered, and that the run left no open wait row, no open node log and,
 * unless it completed, no `run_completed` audit event. Answers the Execution id.
 */
export async function expectSettledExecution(
  host: ReliabilityHost,
  workflowId: string,
  status: "completed" | "canceled" | "exited"
) {
  const runs = await eventually(
    `Execution ${status}`,
    () =>
      host.run(
        host.repo.listByWorkflow({ workflowId, includeSuperseded: true })
      ),
    (rows) => rows.length === 1 && rows[0]?.status === status
  );
  const executionId = runs[0].id;
  await eventually(
    "schedule row and step memo deleted",
    async () => ({
      schedule: await host.run(host.repo.findSchedule({ executionId })),
      stepMemo: await host.run(host.repo.listStepMemo({ executionId })),
    }),
    ({ schedule, stepMemo }) => schedule === null && stepMemo.length === 0
  );
  const inboxIds = await host.inboxIds();
  expect(inboxIds.length).toBeGreaterThan(0);
  const deliveries = await eventually(
    "Event deliveries settled",
    () =>
      Promise.all(
        inboxIds.map((inboxId) => host.run(host.repo.findInboxEvent(inboxId)))
      ),
    (rows) => rows.every((row) => row !== null && row.status !== "pending")
  );
  expect(deliveries.filter((row) => row?.status !== "delivered")).toEqual([]);
  // The terminal write cancels every open park in its own transaction, so a
  // run that ended leaves no wait row waiting.
  expect(await host.run(host.repo.listWaitingStates(executionId))).toEqual([]);
  const logs = await host.run(host.repo.listLogs(executionId));
  // A Wait that a Cancel or Exit claim stopped keeps its run-log row open,
  // which the Runs view reads as cancelled. Every other row is closed, and a
  // completed run leaves no row open at all.
  expect(
    logs.filter(
      (log) =>
        (log.status === "running" || log.status === "pending") &&
        (status === "completed" || log.nodeType !== "Wait")
    )
  ).toEqual([]);
  const events = await host.run(host.repo.listEvents(executionId));
  if (status !== "completed")
    expect(
      events.filter((event) => event.eventType === "run_completed")
    ).toEqual([]);
  return executionId;
}
