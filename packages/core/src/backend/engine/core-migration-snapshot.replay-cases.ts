/**
 * The Migration graph the migration-snapshot suite drives, and its case: the
 * node behind a migrated Wait reads an output a pass under the earlier version
 * produced.
 */

import { expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";
import {
  createLifecycleNode,
  createWaitNode,
  createAfterWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";
import type { WorkflowActions } from "#src/backend/engine/actions";

/**
 * The graph before and after a Migration. Before it, `source` runs behind a
 * one-second Wait `wait_b` and above the ten-second `wait_1`. After it,
 * `wait_b` is gone and `source` hangs off the Lifecycle Node directly. In both,
 * `after` sits below `wait_1`, so every node it can read is upstream of it.
 * The version after the Migration has `after` read `source`, and with
 * `returnToOriginal` the version before it does too.
 */
export function migrationGraph(migrated: boolean, returnToOriginal: boolean) {
  const source = { ...createAfterWaitNode(), id: "source" };
  const after: WorkflowNode = {
    ...createAfterWaitNode(),
    id: "after",
    data: {
      type: "action",
      label: "After",
      config: {
        actionType: "record",
        subject: "{{@source:Source.condition}}",
      },
    },
  };
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("life"),
      source,
      createWaitNode("wait_1", { waitMode: "delay", waitDuration: "10s" }),
      ...(migrated
        ? []
        : [
            createWaitNode("wait_b", {
              waitMode: "delay",
              waitDuration: "1s",
            }),
          ]),
      migrated || returnToOriginal
        ? after
        : {
            ...after,
            data: {
              ...after.data,
              config: { actionType: "record", subject: "original" },
            },
          },
    ],
    edges: [
      ...(migrated
        ? [
            {
              id: "ls",
              source: "life",
              target: "source",
              sourceHandle: "started",
            },
          ]
        : [
            {
              id: "lb",
              source: "life",
              target: "wait_b",
              sourceHandle: "started",
            },
            { id: "bs", source: "wait_b", target: "source" },
          ]),
      { id: "sw", source: "source", target: "wait_1", sourceHandle: "true" },
      { id: "wa", source: "wait_1", target: "after" },
    ],
  });
}

/** An action that answers with the `subject` it was handed. */
const actions: WorkflowActions = {
  stepFor: () => (input) =>
    Effect.succeed({ success: true, data: { subject: input.subject } }),
  metadataFor: () => ({
    label: "Record",
    literalConfigKeys: [],
    templateJsonConfigShapes: [],
  }),
  catalogFingerprint: () => "catalog",
};

/** Whether the `source` node's run-log row has been opened and closed. */
function sourceDone(store: ReturnType<typeof createRecordingWorkflowStore>) {
  const logId = store.logIdOf("source");
  return (
    logId !== undefined &&
    store.callsOf("completeStepLog").some((call) => call.logId === logId)
  );
}

export function defineMigrationSnapshotReplayCases(
  executor: ReplayExecutor
): void {
  // The node behind a migrated Wait reads the output of a node a pass under
  // the earlier version ran. Each pass loads the version the run is pinned to,
  // and the traversal it rebuilds from the memo holds `source`'s output under
  // either graph.
  it.each([false, true])(
    "reads an output from before the migration behind the migrated Wait (return to original version: %s)",
    async (returnToOriginal) => {
      const store = createRecordingWorkflowStore();
      const run = await driveWithReplay(
        (runtime) => {
          const migrated =
            sourceDone(store) &&
            (!returnToOriginal ||
              store.callsOf("reparkWaitState").length === 0);
          return executeTestWorkflow(
            {
              graph: migrationGraph(migrated, returnToOriginal),
              executionId: "exec_wait",
              workflowId: "wf",
              workflowVersionId: migrated ? "new" : "old",
            },
            runtime,
            store,
            actions
          );
        },
        { executor, waitRows: store }
      );

      expect(run.value.results.after).toMatchObject({
        success: true,
        data: { success: true, data: { subject: "true" } },
      });
      expect(store.callsOf("reparkWaitState").length).toBeGreaterThan(0);
    }
  );
}
