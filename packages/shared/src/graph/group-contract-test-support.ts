/**
 * The Group boundary matrix: one graph per Group shape and the rules
 * `groupContractViolations` reports for it. The shared test and the core
 * publication test both run every case, so the two verdicts cannot drift. Each
 * graph starts at a Lifecycle Node and has one Group, `g`, labelled "Lookups".
 */

import type { GroupContractRule } from "#src/graph/group-contract";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { eventSplitOutlet } from "#src/lifecycle/event-split";
import { LIFECYCLE_STARTED_HANDLE } from "#src/lifecycle/lifecycle-outlets";

export type GroupContractMatrixCase = {
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The rules the Group breaks, in the order the validation reports them. */
  rules: GroupContractRule[];
  /**
   * Whether the draft save's topology check accepts the graph. A case the save
   * refuses reports no Group rule, because the save's own check owns that rule.
   */
  savesAsDraft: boolean;
};

/** The action type every ordinary step in the matrix names. */
export const MATRIX_LOOKUP_ACTION = "custom/lookup";

const GROUP_ID = "g";

function lifecycle(parentId?: string): WorkflowNode {
  return {
    id: "life",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Start",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: [],
          cancelEvents: [],
          concurrency: "newest-wins",
          allowManualStart: true,
        },
      },
    },
    parentId,
  };
}

function frame(): WorkflowNode {
  return {
    id: GROUP_ID,
    type: "group",
    position: { x: 0, y: 0 },
    data: { label: "Lookups", type: "group", config: {} },
  };
}

function step(
  id: string,
  options: { inGroup?: boolean; actionType?: string | undefined } = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: `Step ${id}`,
      type: "action",
      config: { actionType: options.actionType ?? MATRIX_LOOKUP_ACTION },
    },
    parentId: options.inGroup ? GROUP_ID : undefined,
  };
}

function member(id: string, actionType?: string): WorkflowNode {
  return step(id, { inGroup: true, actionType });
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return {
    id: `${source}-${sourceHandle ?? "out"}-${target}`,
    source,
    target,
    sourceHandle,
  };
}

function started(target: string): WorkflowEdge {
  return edge("life", target, LIFECYCLE_STARTED_HANDLE);
}

export const groupContractMatrix: readonly GroupContractMatrixCase[] = [
  {
    name: "valid linear Group",
    nodes: [lifecycle(), frame(), member("a"), member("b"), step("send")],
    edges: [started("a"), edge("a", "b"), edge("b", "send")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "fan-out from one external source port",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("b"),
      step("send"),
    ],
    edges: [started("s"), edge("s", "a"), edge("s", "b"), edge("a", "send")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "two external source ports",
    nodes: [
      lifecycle(),
      step("s"),
      step("t"),
      frame(),
      member("a"),
      member("b"),
    ],
    edges: [started("s"), started("t"), edge("s", "a"), edge("t", "b")],
    rules: ["multiple_ingress_sources"],
    savesAsDraft: true,
  },
  {
    name: "one continuation port to two targets",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      step("x"),
      step("y"),
    ],
    edges: [started("a"), edge("a", "b"), edge("b", "x"), edge("b", "y")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "two continuation ports",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      step("x"),
      step("y"),
    ],
    edges: [started("a"), edge("a", "b"), edge("a", "x"), edge("b", "y")],
    rules: ["multiple_continuations"],
    savesAsDraft: true,
  },
  {
    name: "two continuation ports to the same target",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("b"),
      step("t"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("s", "b"),
      edge("a", "t"),
      edge("b", "t"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "parallel members continue to one shared outside step",
    nodes: [lifecycle(), frame(), member("a"), member("b"), step("t")],
    edges: [started("a"), started("b"), edge("a", "t"), edge("b", "t")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "two continuation ports to two different outside steps",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      step("x"),
      step("y"),
    ],
    edges: [
      started("a"),
      started("b"),
      edge("a", "x"),
      edge("b", "x"),
      edge("b", "y"),
    ],
    rules: ["multiple_continuations"],
    savesAsDraft: true,
  },
  {
    name: "terminal path inside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      member("c"),
      step("send"),
    ],
    edges: [started("a"), edge("a", "b"), edge("a", "c"), edge("b", "send")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "Condition True continues and False ends inside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("c", "Condition"),
      member("d"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "c"),
      edge("c", "send", "true"),
      edge("c", "d", "false"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "Condition True continues and an unconnected False ends inside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("c", "Condition"),
      step("send"),
    ],
    edges: [started("a"), edge("a", "c"), edge("c", "send", "true")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "both Condition branches inside the Group and one continues through a step",
    nodes: [
      lifecycle(),
      frame(),
      member("c", "Condition"),
      member("a"),
      member("b"),
      step("send"),
    ],
    edges: [
      started("c"),
      edge("c", "a", "true"),
      edge("c", "b", "false"),
      edge("a", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "both Condition branches end inside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("c", "Condition"),
      member("a"),
      member("b"),
    ],
    edges: [started("c"), edge("c", "a", "true"), edge("c", "b", "false")],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "both Condition branches continue outside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("c", "Condition"),
      step("x"),
      step("y"),
    ],
    edges: [
      started("a"),
      edge("a", "c"),
      edge("c", "x", "true"),
      edge("c", "y", "false"),
    ],
    rules: ["multiple_continuations"],
    savesAsDraft: true,
  },
  {
    name: "a Condition branch and a step continue to the same outside step",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("c", "Condition"),
      member("b"),
      step("t"),
    ],
    edges: [
      started("a"),
      edge("a", "c"),
      edge("a", "b"),
      edge("c", "t", "true"),
      edge("b", "t"),
    ],
    rules: ["conditional_join_arm"],
    savesAsDraft: true,
  },
  {
    name: "Condition True path feeds a join outside while False ends inside",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("c", "Condition"),
      member("a"),
      member("f"),
      step("d"),
      step("j"),
    ],
    edges: [
      started("s"),
      edge("s", "c"),
      edge("c", "a", "true"),
      edge("c", "f", "false"),
      edge("a", "j"),
      edge("s", "d"),
      edge("d", "j"),
    ],
    rules: ["conditional_join_arm"],
    savesAsDraft: true,
  },
  {
    name: "Condition True path feeds a join inside while False ends inside",
    nodes: [
      lifecycle(),
      frame(),
      member("e"),
      member("c", "Condition"),
      member("a"),
      member("b"),
      member("f"),
      member("j"),
    ],
    edges: [
      started("e"),
      edge("e", "c"),
      edge("e", "b"),
      edge("c", "a", "true"),
      edge("c", "f", "false"),
      edge("a", "j"),
      edge("b", "j"),
    ],
    rules: ["conditional_join_arm"],
    savesAsDraft: true,
  },
  {
    name: "join wholly inside the Group",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("b"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("s", "b"),
      edge("a", "j"),
      edge("b", "j"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "join split across the boundary",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("s", "j"),
      edge("a", "j"),
      edge("j", "send"),
    ],
    rules: ["join_crosses_boundary"],
    savesAsDraft: true,
  },
  {
    name: "Group on one arm of a join outside it",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("b"),
      step("c"),
      step("j"),
      step("x"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("a", "b"),
      edge("b", "j"),
      edge("b", "x"),
      edge("s", "c"),
      edge("c", "j"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "Group whose only continuation is a join outside",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("b"),
      step("c"),
      step("j"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("a", "b"),
      edge("b", "j"),
      edge("s", "c"),
      edge("c", "j"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "Group on an arm beside the fan-out's own edge into a join outside",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("b"),
      member("b2"),
      step("j"),
    ],
    edges: [
      started("s"),
      edge("s", "b"),
      edge("b", "b2"),
      edge("b2", "j"),
      edge("s", "j"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "join inside the Group beside the fan-out's own edge into it",
    nodes: [
      lifecycle(),
      frame(),
      member("s"),
      member("b"),
      member("b2"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("s"),
      edge("s", "b"),
      edge("b", "b2"),
      edge("b2", "j"),
      edge("s", "j"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "Condition True feeds a join inside the Group directly and through a step",
    nodes: [
      lifecycle(),
      frame(),
      member("c", "Condition"),
      member("b"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("c"),
      edge("c", "b", "true"),
      edge("c", "j", "true"),
      edge("b", "j"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "Group with a Condition on an arm of a join outside it",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("c", "Condition"),
      member("b"),
      step("d"),
      step("j"),
    ],
    edges: [
      started("s"),
      edge("s", "c"),
      edge("c", "b", "true"),
      edge("b", "j"),
      edge("s", "d"),
      edge("d", "j"),
    ],
    rules: ["conditional_join_arm"],
    savesAsDraft: true,
  },
  {
    name: "Wait on an inside join arm",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("w", "Wait"),
      member("j"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("s", "w"),
      edge("a", "j"),
      edge("w", "j"),
    ],
    rules: [],
    savesAsDraft: false,
  },
  {
    name: "Condition on an inside join arm",
    nodes: [
      lifecycle(),
      step("s"),
      frame(),
      member("a"),
      member("c", "Condition"),
      member("b"),
      member("j"),
    ],
    edges: [
      started("s"),
      edge("s", "a"),
      edge("s", "c"),
      edge("c", "b", "true"),
      edge("a", "j"),
      edge("b", "j"),
    ],
    rules: ["conditional_join_arm"],
    savesAsDraft: true,
  },
  {
    name: "internal fan-out joins and continues through one port",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      member("c"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "j"),
      edge("c", "j"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "internal fan-out with uneven arms joins and continues",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      member("b2"),
      member("c"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "b"),
      edge("b", "b2"),
      edge("a", "c"),
      edge("b2", "j"),
      edge("c", "j"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "join inside the Group with a branch through a step outside it",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      step("x"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "b"),
      edge("a", "x"),
      edge("x", "j"),
      edge("b", "j"),
      edge("j", "send"),
    ],
    rules: [
      "multiple_ingress_sources",
      "multiple_continuations",
      "join_crosses_boundary",
    ],
    savesAsDraft: true,
  },
  {
    name: "Wait on an arm of an internal fan-out's join",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      member("w", "Wait"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "b"),
      edge("a", "w"),
      edge("b", "j"),
      edge("w", "j"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: false,
  },
  {
    name: "Condition on an inside join arm whose False branch ends inside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("c", "Condition"),
      member("b"),
      member("d"),
      member("e"),
      member("j"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "c"),
      edge("c", "b", "true"),
      edge("c", "d", "false"),
      edge("a", "e"),
      edge("b", "j"),
      edge("e", "j"),
      edge("j", "send"),
    ],
    rules: ["conditional_join_arm"],
    savesAsDraft: true,
  },
  {
    name: "internal join wholly on one branch of a Condition inside the Group",
    nodes: [
      lifecycle(),
      frame(),
      member("c", "Condition"),
      member("a"),
      member("b"),
      member("j"),
      member("d"),
      step("send"),
    ],
    edges: [
      started("c"),
      edge("c", "a", "true"),
      edge("c", "b", "true"),
      edge("a", "j"),
      edge("b", "j"),
      edge("c", "d", "false"),
      edge("j", "send"),
    ],
    rules: [],
    savesAsDraft: true,
  },
  {
    name: "one member",
    nodes: [lifecycle(), frame(), member("a"), step("send")],
    edges: [started("a"), edge("a", "send")],
    rules: ["too_few_members"],
    savesAsDraft: true,
  },
  {
    name: "Event Split member",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("e", "Event Split"),
      step("send"),
    ],
    edges: [
      started("a"),
      edge("a", "e"),
      edge("e", "send", eventSplitOutlet("app/order.created")),
    ],
    rules: ["too_few_members", "disallowed_member"],
    savesAsDraft: true,
  },
  {
    name: "Lifecycle member",
    nodes: [frame(), lifecycle(GROUP_ID), member("a"), member("b")],
    edges: [started("a"), edge("a", "b")],
    rules: [],
    savesAsDraft: false,
  },
  {
    name: "Add node member",
    nodes: [
      lifecycle(),
      frame(),
      member("a"),
      member("b"),
      {
        id: "add",
        type: "add",
        position: { x: 0, y: 0 },
        data: { label: "", type: "add" },
        parentId: GROUP_ID,
      },
    ],
    edges: [started("a"), edge("a", "b")],
    rules: [],
    savesAsDraft: false,
  },
];
