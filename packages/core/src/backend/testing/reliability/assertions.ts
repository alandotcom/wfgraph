import { expect } from "vitest";
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
