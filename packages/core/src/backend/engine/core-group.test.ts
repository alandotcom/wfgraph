/**
 * A Group is organizational, so grouping a linear sequence must leave every run
 * of the workflow unchanged. These cases run the same chain, holding a lookup, a
 * side-effecting action and a Wait, ungrouped and inside a Group laid out in
 * each direction, and compare what the engine dispatched and recorded.
 */

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { groupContractViolations } from "@wfgraph/shared/graph/group-contract";
import { analyzeGroupableSelection } from "@wfgraph/shared/graph/node-group";
import type { GroupLayoutDirection } from "@wfgraph/shared/graph/schemas";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { createLifecycleNode } from "#src/backend/engine/testing/wait-fixtures";

function step(id: string, config: Record<string, unknown>): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config },
  };
}

const NODES: WorkflowNode[] = [
  createLifecycleNode("life"),
  step("read", { actionType: "test/read", customerId: "cus_1" }),
  step("send", { actionType: "test/send", to: "{{@read:read.email}}" }),
  step("wait", {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "delay",
    waitDuration: "1h",
  }),
  step("after", { actionType: "test/read", customerId: "cus_2" }),
];

const EDGES: WorkflowEdge[] = [
  { id: "life-read", source: "life", target: "read", sourceHandle: "started" },
  { id: "read-send", source: "read", target: "send" },
  { id: "send-wait", source: "send", target: "wait" },
  { id: "wait-after", source: "wait", target: "after" },
];

const MEMBER_IDS = new Set(["read", "send", "wait"]);

/** The same nodes and edges with `read`, `send` and `wait` inside one Group. */
function grouped(direction: GroupLayoutDirection): WorkflowNode[] {
  return [
    {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Outreach", type: "group", config: { direction } },
    },
    ...NODES.map((node) =>
      MEMBER_IDS.has(node.id) ? { ...node, parentId: "group" } : node
    ),
  ];
}

/**
 * Actions that record every dispatch in order. `test/send` stands for an action
 * with a side effect: the engine reads no such flag, which is the point.
 */
function recordingActions() {
  const dispatched: Array<{
    actionType: string;
    input: Record<string, unknown>;
  }> = [];
  const actions: WorkflowActions = {
    stepFor: (actionType) => (input) =>
      Effect.sync(() => {
        dispatched.push({ actionType, input });
        return {
          success: true as const,
          data: { email: "person@example.com" },
        };
      }),
    metadataFor: (actionType) => ({
      label: actionType,
      literalConfigKeys: [],
      templateJsonConfigShapes: [],
    }),
    catalogFingerprint: () => "catalog",
  };
  return { actions, dispatched };
}

async function run(nodes: WorkflowNode[]) {
  const store = createRecordingWorkflowStore();
  const runtime = createInMemoryWorkflowRuntime();
  const { actions, dispatched } = recordingActions();
  const result = await executeTestWorkflow(
    {
      graph: createSerializedWorkflowGraph({ nodes, edges: EDGES }),
      executionId: "exec_group",
      workflowId: "workflow_group",
    },
    runtime,
    store,
    actions
  );
  return {
    status: result.status,
    success: result.success,
    results: result.results,
    dispatched,
    durableSteps: [...runtime.memo.keys()],
    storeCalls: store.calls,
  };
}

describe("a Group around a linear sequence", () => {
  // The Wait and the run log stamp times, so both runs read one fixed clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a Group the editor may create and Publish accepts", () => {
    expect(
      analyzeGroupableSelection({
        nodes: NODES,
        edges: EDGES,
        selectedIds: MEMBER_IDS,
      })
    ).toEqual({ ok: true, memberIds: ["read", "send", "wait"] });
    expect(
      groupContractViolations({ nodes: grouped("vertical"), edges: EDGES })
    ).toEqual([]);
  });

  it.each(["vertical", "horizontal"] as const)(
    "runs identically when grouped with a %s layout",
    async (direction) => {
      const before = await run(NODES);
      const after = await run(grouped(direction));

      expect(before.success).toBe(true);
      expect(before.dispatched.map((call) => call.actionType)).toEqual([
        "test/read",
        "test/send",
        "test/read",
      ]);
      expect(Object.keys(before.results).sort()).toEqual(
        ["after", "life", "read", "send", "wait"].sort()
      );
      expect(after).toEqual(before);
    }
  );
});
