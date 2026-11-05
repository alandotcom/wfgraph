/**
 * What a Migration does to a Wait that is already parked.
 *
 * A Migration moves an open Execution to another Workflow Version while the run
 * is parked, so the body the executor calls next loads a different graph for
 * the same wait row. These cases drive that through `driveWithReplay`, which
 * calls the body again from the top on every wake, and swap the config between
 * calls. Each runs under both the Inngest and the database executor, and is
 * declared in `core-wait-migrate.replay-cases.ts` so the replay suite runners
 * can run it on a real database too. The cases about what one park does live
 * in `core-wait.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { executeTestWorkflowBranch } from "#src/backend/engine/test-execution";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { IN_PLACE_EXECUTORS } from "#src/backend/engine/testing/replay-runtime";
import {
  createLifecycleNode,
  createWaitNode,
  createAfterWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";
import { defineWaitMigrateReplayCases } from "#src/backend/engine/core-wait-migrate.replay-cases";

describe.each(IN_PLACE_EXECUTORS)(
  "wait node - migration to a later workflow version ($kind executor)",
  defineWaitMigrateReplayCases
);

it("resumes an owned branch Wait after migration rewires its completed predecessors", async () => {
  const store = createRecordingWorkflowStore();
  const graph = createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      { ...createAfterWaitNode(), id: "added_1" },
      createWaitNode("wait_1", { waitMode: "delay", waitDuration: "1s" }),
      createAfterWaitNode(),
    ],
    edges: [
      {
        id: "new-entry",
        source: "lifecycle_1",
        target: "added_1",
        sourceHandle: "started",
      },
      { id: "new-before-wait", source: "added_1", target: "wait_1" },
      { id: "after", source: "wait_1", target: "after_wait" },
    ],
  });
  const result = await executeTestWorkflowBranch(
    {
      graph,
      executionId: "exec_wait",
      workflowId: "workflow_wait",
      workflowVersionId: "ver_2",
      entryNodeId: "wait_1",
      side: "started",
      releasedEdges: [
        { source: "lifecycle_1", target: "wait_1", sourceHandle: "started" },
        { source: "lifecycle_1", target: "added_1", sourceHandle: "started" },
      ],
    },
    createInMemoryWorkflowRuntime(),
    {
      ...store,
      readNodeOutputs: () =>
        Effect.succeed({ lifecycle_1: {}, added_1: { condition: true } }),
    },
    noWorkflowActions
  );
  expect(result.results.wait_1?.success).toBe(true);
  expect(result.results.after_wait?.success).toBe(true);
  expect(
    store.callsOf("startStepLog").some((call) => call.nodeId === "added_1")
  ).toBe(false);
});
