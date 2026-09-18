import { expect } from "vitest";
import { sortBy } from "es-toolkit/array";
import { mapValues } from "es-toolkit/object";
import type { JsonValue } from "@wfgraph/shared/types/json";
import type { ReliabilityHost } from "#src/backend/testing/reliability/host";
import { eventually } from "#src/backend/testing/reliability/control";

export async function waitForRegisteredWaits(
  host: ReliabilityHost,
  executionId: string,
  count: number
) {
  const waits = await eventually(
    "persisted Waits",
    () => host.run(host.repo.listWaitingStates(executionId)),
    (rows) => rows.length === count
  );
  return waitForDurableSuspension(host, waits);
}

/**
 * Waits until the Execution is parked on exactly the Wait nodes `nodeIds`, each
 * with a persisted row and a registered Inngest wait or sleep.
 */
export async function waitForOpenWaits(
  host: ReliabilityHost,
  executionId: string,
  nodeIds: readonly string[]
) {
  const expected = nodeIds.toSorted();
  const waits = await eventually(
    `open Waits at [${expected.join(", ")}]`,
    () => host.run(host.repo.listWaitingStates(executionId)),
    (rows) =>
      rows.length === expected.length &&
      rows
        .map((row) => row.nodeId)
        .toSorted()
        .every((nodeId, index) => nodeId === expected[index])
  );
  return waitForDurableSuspension(host, waits);
}

async function waitForDurableSuspension<
  W extends { nodeId: string; runId: string },
>(host: ReliabilityHost, waits: W[]) {
  await Promise.all(
    waits.map((wait) =>
      eventually(
        `durable suspension at ${wait.nodeId}`,
        () => host.runtime.runState(wait.runId),
        (state) =>
          state?.history.some(
            (item) =>
              item.type === "StepWaiting" || item.type === "StepSleeping"
          ) === true
      )
    )
  );
  return waits;
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
  const durableRuns = await eventually(
    "durable runs settled",
    () => host.runtime.allRuns(),
    (rows) =>
      rows.length > 0 &&
      rows.every((row) => !["RUNNING", "QUEUED"].includes(row.status))
  );
  const allowed =
    status === "exited" ? ["COMPLETED", "CANCELLED"] : ["COMPLETED"];
  expect(durableRuns.filter((run) => !allowed.includes(run.status))).toEqual(
    []
  );
  const executionId = runs[0].id;
  expect(await host.run(host.repo.listActiveWaitStates(executionId))).toEqual(
    []
  );
  const logs = await host.run(host.repo.listLogs(executionId));
  expect(
    logs.filter((log) => log.status === "running" || log.status === "pending")
  ).toEqual([]);
  const events = await host.run(host.repo.listEvents(executionId));
  if (status !== "completed")
    expect(
      events.filter((event) => event.eventType === "run_completed")
    ).toEqual([]);
  return executionId;
}
