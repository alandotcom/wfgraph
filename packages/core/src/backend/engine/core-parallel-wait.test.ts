/**
 * What a Wait node costs the branches beside it.
 *
 * A durable runtime suspends the run rather than the branch, so these cases run
 * through `driveWithReplay` instead of the in-memory runtime: only a driver that
 * calls the body again on a virtual clock can show a branch stopping at a Wait.
 * The graph is the one that surfaced the defect, an entry node whose Started
 * outlet feeds both an Event Split and a Wait.
 *
 * The cases in `core-parallel-wait.replay-cases.ts` run under both executors:
 * the Inngest executor hands each Wait to a branch run of its own (ADR-0011),
 * and the database executor parks every Wait in the one run, which wakes on any
 * resolution. They live there so the replay suite runners can run them on a
 * real database too. The cases here belong to neither or to Inngest alone.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import type { ReplayExecutor } from "#src/backend/engine/testing/replay-runtime";
import {
  actions,
  CANCELABLE,
  cancelableWaitGraph,
  defineParallelWaitReplayCases,
  dispatchClock,
  lifecycleNode,
  runGraph,
  sendNode,
  START_EVENT,
  waitNode,
} from "#src/backend/engine/core-parallel-wait.replay-cases";

describe("a wait node beside another branch", () => {
  describe.each<ReplayExecutor>([{ kind: "inngest" }, { kind: "database" }])(
    "under the $kind executor",
    defineParallelWaitReplayCases
  );

  /**
   * The rows a killed branch leaves behind. It was stopped where it stood, so
   * nothing inside it can close its own row, and the run that started it is
   * the only thing alive that knows the Execution.
   */
  it("closes what a killed branch left open before taking the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();
    let reads = 0;
    const cancelStore: WorkflowStore = {
      ...store,
      // The entry node reads first and finds nothing, which is what lets the
      // wait be handed off at all. The cancel lands while the branch is parked,
      // and the node that handed it off is the next to ask.
      readPendingCancel: (executionId: string) =>
        Effect.gen(function* () {
          yield* store.readPendingCancel(executionId);
          reads += 1;
          return reads === 1
            ? null
            : ({
                eventName: "app/appointment.canceled",
                payload: {},
              } satisfies PendingCancel);
        }),
    };

    const run = await runGraph(
      cancelableWaitGraph(),
      { kind: "inngest", killBranchesAtMs: 30_000 },
      { store: cancelStore }
    );

    // The branch died mid-sleep, so the node behind it never ran.
    expect(dispatchClock(run.executed, "reminder")).toBeUndefined();
    expect(store.callsOf("cancelOpenWork")).toHaveLength(1);

    // Order is the whole of what makes the sweep safe: after the kill was
    // observed, before the Canceled branch opened a row of its own.
    const sweptAt = store.calls.findIndex(
      (call) => call.method === "cancelOpenWork"
    );
    const canceledBranchAt = store.calls.findIndex(
      (call) =>
        call.method === "startStepLog" && call.input.nodeId === "canceled_sms"
    );
    expect(sweptAt).toBeGreaterThanOrEqual(0);
    expect(sweptAt).toBeLessThan(canceledBranchAt);
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });

  /**
   * A wait held back is the one thing a run carries across the Canceled outlet.
   * Every other node on the Started branch stops there by never being scheduled,
   * so this is the case the queue has to answer for itself.
   */
  it("drops a held-back wait once the run has taken the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();
    let reads = 0;
    const cancelStore = {
      ...store,
      // The entry node reads first and finds nothing, which is what lets the
      // Started branch fan out and park its wait in the queue. The cancel lands
      // at the node after it.
      readPendingCancel: (executionId: string) =>
        Effect.gen(function* () {
          yield* store.readPendingCancel(executionId);
          reads += 1;
          return reads === 1
            ? null
            : ({
                eventName: "app/appointment.canceled",
                payload: {},
              } satisfies PendingCancel);
        }),
    };

    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
          nodes: [
            lifecycleNode("entry", CANCELABLE),
            sendNode("scheduled_sms"),
            waitNode("wait_before", "30s"),
            sendNode("reminder"),
            sendNode("canceled_sms"),
          ],
          edges: [
            {
              id: "e1",
              source: "entry",
              sourceHandle: "started",
              target: "scheduled_sms",
            },
            {
              id: "e2",
              source: "entry",
              sourceHandle: "started",
              target: "wait_before",
            },
            {
              id: "e3",
              source: "wait_before",
              sourceHandle: null,
              target: "reminder",
            },
            {
              id: "e4",
              source: "entry",
              sourceHandle: "canceled",
              target: "canceled_sms",
            },
          ],
        }),
        executionId: "exec_cancel",
        workflowId: "workflow_cancel",
        startEventName: START_EVENT,
      },
      createInMemoryWorkflowRuntime(),
      cancelStore,
      actions
    );

    expect(result).toMatchObject({ kind: "ended", success: true });
    // No wait state, so the run never parked on a branch it had left.
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "entry",
      "scheduled_sms",
      "canceled_sms",
    ]);
  });
});
