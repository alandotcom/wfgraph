/**
 * A Group is organizational, so grouping steps must leave every run of the
 * workflow unchanged. These cases run a linear chain and a fan-out from one
 * outside outlet, ungrouped and inside a Group laid out in each direction, and
 * compare what the engine dispatched and recorded.
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

/** `nodes` with `memberIds` inside one Group laid out along `direction`. */
function grouped(
  direction: GroupLayoutDirection,
  nodes: readonly WorkflowNode[] = NODES,
  memberIds: ReadonlySet<string> = MEMBER_IDS
): WorkflowNode[] {
  return [
    {
      id: "group",
      type: "group",
      position: { x: 0, y: 0 },
      data: { label: "Outreach", type: "group", config: { direction } },
    },
    ...nodes.map((node) =>
      memberIds.has(node.id) ? { ...node, parentId: "group" } : node
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

async function run(nodes: WorkflowNode[], edges: WorkflowEdge[] = EDGES) {
  const store = createRecordingWorkflowStore();
  const runtime = createInMemoryWorkflowRuntime();
  const { actions, dispatched } = recordingActions();
  const result = await executeTestWorkflow(
    {
      graph: createSerializedWorkflowGraph({ nodes, edges }),
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

  it("writes run logs, results and every other store record for real steps alone", async () => {
    const { results, storeCalls } = await run(grouped("vertical"));

    const loggedNodeIds = storeCalls.flatMap((call) =>
      call.method === "startStepLog" ? [call.input.nodeId] : []
    );
    expect(loggedNodeIds).toEqual(["life", "read", "send", "wait", "after"]);
    expect(Object.keys(results)).not.toContain("group");
    // No store call of any kind names the frame: a log, its input or output,
    // a wait, an audit event, a cancellation sweep, or the run's completion.
    expect(JSON.stringify(storeCalls)).not.toContain('"group"');
  });
});

/**
 * A Condition `gate` whose True outlet fans out onto the lookups `read` and
 * `profile` and whose False outlet reaches `fallback`. `read` feeds `send`,
 * which continues to `after`, and `profile` ends its path. `gate` reads the
 * literal `open`.
 */
function fanOut(open: boolean): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const condition = BUILT_IN_ACTION_IDS.condition;
  return {
    nodes: [
      createLifecycleNode("life"),
      step("gate", { actionType: condition, condition: open }),
      step("read", { actionType: "test/read", customerId: "cus_1" }),
      step("profile", { actionType: "test/read", customerId: "cus_3" }),
      step("send", { actionType: "test/send", to: "{{@read:read.email}}" }),
      step("after", { actionType: "test/read", customerId: "cus_2" }),
      step("fallback", { actionType: "test/send", to: "ops@example.com" }),
    ],
    edges: [
      {
        id: "life-gate",
        source: "life",
        target: "gate",
        sourceHandle: "started",
      },
      { id: "gate-read", source: "gate", target: "read", sourceHandle: "true" },
      {
        id: "gate-profile",
        source: "gate",
        target: "profile",
        sourceHandle: "true",
      },
      {
        id: "gate-fallback",
        source: "gate",
        target: "fallback",
        sourceHandle: "false",
      },
      { id: "read-send", source: "read", target: "send" },
      { id: "send-after", source: "send", target: "after" },
    ],
  };
}

const FAN_OUT_MEMBER_IDS = new Set(["read", "profile", "send"]);

describe("a Group around a fan-out from one outside outlet", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a Group the editor may create and Publish accepts", () => {
    const { nodes, edges } = fanOut(true);
    expect(
      analyzeGroupableSelection({
        nodes,
        edges,
        selectedIds: FAN_OUT_MEMBER_IDS,
      })
    ).toEqual({ ok: true, memberIds: ["read", "profile", "send"] });
    expect(
      groupContractViolations({
        nodes: grouped("vertical", nodes, FAN_OUT_MEMBER_IDS),
        edges,
      })
    ).toEqual([]);
  });

  it.each([
    { open: true, direction: "vertical" },
    { open: true, direction: "horizontal" },
    { open: false, direction: "vertical" },
    { open: false, direction: "horizontal" },
  ] as const)(
    "releases the same children with the gate open $open in a $direction Group",
    async ({ open, direction }) => {
      const { nodes, edges } = fanOut(open);
      const before = await run(nodes, edges);
      const after = await run(
        grouped(direction, nodes, FAN_OUT_MEMBER_IDS),
        edges
      );

      expect(before.success).toBe(true);
      const released = Object.keys(before.results).sort();
      expect(released).toEqual(
        open
          ? ["after", "gate", "life", "profile", "read", "send"]
          : ["fallback", "gate", "life"]
      );
      expect(Object.keys(after.results).sort()).toEqual(released);
      expect(after).toEqual(before);
    }
  );
});

/**
 * `qualify` fans out onto the lookups `read` and `profile`, which join at
 * `merge`, and `merge` continues to `after`. `merge` reads both lookups.
 */
function joiningFanOut(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      createLifecycleNode("life"),
      step("qualify", { actionType: "test/read", customerId: "cus_0" }),
      step("read", { actionType: "test/read", customerId: "cus_1" }),
      step("profile", { actionType: "test/read", customerId: "cus_3" }),
      step("merge", {
        actionType: "test/send",
        to: "{{@read:read.email}}",
        cc: "{{@profile:profile.email}}",
      }),
      step("after", { actionType: "test/read", customerId: "cus_2" }),
    ],
    edges: [
      {
        id: "life-qualify",
        source: "life",
        target: "qualify",
        sourceHandle: "started",
      },
      { id: "qualify-read", source: "qualify", target: "read" },
      { id: "qualify-profile", source: "qualify", target: "profile" },
      { id: "read-merge", source: "read", target: "merge" },
      { id: "profile-merge", source: "profile", target: "merge" },
      { id: "merge-after", source: "merge", target: "after" },
    ],
  };
}

const JOINING_MEMBER_IDS = new Set(["read", "profile", "merge"]);

describe("a Group around a fan-out that joins inside it", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a Group the editor may create and Publish accepts", () => {
    const { nodes, edges } = joiningFanOut();
    expect(
      analyzeGroupableSelection({
        nodes,
        edges,
        selectedIds: JOINING_MEMBER_IDS,
      })
    ).toMatchObject({ ok: true });
    expect(
      groupContractViolations({
        nodes: grouped("vertical", nodes, JOINING_MEMBER_IDS),
        edges,
      })
    ).toEqual([]);
  });

  it.each(["vertical", "horizontal"] as const)(
    "runs the join identically when grouped with a %s layout",
    async (direction) => {
      const { nodes, edges } = joiningFanOut();
      const before = await run(nodes, edges);
      const after = await run(
        grouped(direction, nodes, JOINING_MEMBER_IDS),
        edges
      );

      expect(before.success).toBe(true);
      expect(Object.keys(before.results).sort()).toEqual(
        ["after", "life", "merge", "profile", "qualify", "read"].sort()
      );
      expect(before.dispatched.map((call) => call.actionType)).toContain(
        "test/send"
      );
      expect(after).toEqual(before);
    }
  );
});
