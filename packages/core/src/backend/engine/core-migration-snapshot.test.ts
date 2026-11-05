import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import {
  executeTestWorkflow,
  executeTestWorkflowBranch,
} from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  actions,
  defineMigrationSnapshotReplayCases,
  migrationGraph,
  sourceDone,
} from "#src/backend/engine/core-migration-snapshot.replay-cases";

it.each([false, true])(
  "refreshes inherited outputs after migration (return to original version: %s)",
  async (returnToOriginal) => {
    const graph = (migrated: boolean) =>
      migrationGraph(migrated, returnToOriginal);
    const store = createRecordingWorkflowStore();
    const run = await driveWithReplay(
      (runtime) =>
        executeTestWorkflow(
          { graph: graph(false), executionId: "exec_wait", workflowId: "wf" },
          runtime,
          store,
          actions
        ),
      {
        executor: {
          kind: "inngest",
          branch: (runtime, input) => {
            const migrated =
              input.entryNodeId === "wait_1" &&
              sourceDone(store) &&
              (!returnToOriginal ||
                store.callsOf("reparkWaitState").length === 0);
            return executeTestWorkflowBranch(
              {
                ...input,
                graph: graph(migrated),
                executionId: "exec_wait",
                workflowId: "wf",
                workflowVersionId: migrated ? "new" : "old",
              },
              runtime,
              store,
              actions
            );
          },
        },
      }
    );

    expect(validateWorkflowGraph(graph(false)).valid).toBe(true);
    expect(validateWorkflowGraph(graph(true)).valid).toBe(true);
    expect(run.value.results.after).toMatchObject({
      success: true,
      data: { success: true, data: { subject: "true" } },
    });
    expect(
      store.callsOf("startStepLog").filter((call) => call.nodeId === "source")
    ).toHaveLength(1);
    expect(store.callsOf("readNodeOutputs")).toHaveLength(5);
  }
);

describe("under the database executor", () => {
  defineMigrationSnapshotReplayCases({ kind: "database" });
});
