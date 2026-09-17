/**
 * The subjects Canvas Reveal can show, and the pure rules that recognize each
 * kind in a selection. `reveal-kinds.tsx` pairs each rule with what the shell
 * renders for that kind.
 */

import { uniq } from "es-toolkit/array";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import type {
  CanvasSelection,
  OpenRevealLevel,
  RevealLevel,
  WorkspaceView,
} from "#src/lib/workflow-navigation-state";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export type RevealKindId =
  | "step"
  | "condition"
  | "group"
  | "lifecycle"
  | "runs"
  | "changes"
  | "panel";

/**
 * What the camera keeps in view while Reveal shows a subject: listed nodes, one
 * node with its outlet handles and each label on an edge leaving them that fits
 * at the zoom the node sets, or the whole presented graph.
 */
export type RevealPlacement =
  | { kind: "nodes"; nodeIds: readonly string[] }
  | { kind: "node-outlets"; nodeId: string }
  | { kind: "graph" };

export type RevealSubject = {
  kind: RevealKindId;
  workspace: WorkspaceView;
  /** Changes whenever Reveal starts showing a different object. */
  key: string;
  /** The one node the subject is about, or null when it is about no single node. */
  nodeId: string | null;
  placement: RevealPlacement;
  /** The open levels the subject offers, Browse first. */
  levels: readonly OpenRevealLevel[];
};

export type RevealMatchInput = {
  workspace: WorkspaceView;
  selection: CanvasSelection;
  nodes: readonly WorkflowNode[];
  edges: readonly Pick<WorkflowEdge, "id" | "source" | "target">[];
};

const NON_ORDINARY_ACTIONS: ReadonlySet<string> = new Set([
  BUILT_IN_ACTION_IDS.condition,
  BUILT_IN_ACTION_IDS.eventSplit,
]);

/**
 * Whether a node is an ordinary step: an action node that is not a Condition
 * or an Event Split. A Wait and an action with no action chosen yet count.
 */
export function isOrdinaryStep(node: Pick<WorkflowNode, "data">): boolean {
  if (node.data.type !== "action") {
    return false;
  }
  const actionType = node.data.config?.actionType;
  return !(
    typeof actionType === "string" && NON_ORDINARY_ACTIONS.has(actionType)
  );
}

function selectedGraph(input: RevealMatchInput): {
  nodes: WorkflowNode[];
  edges: RevealMatchInput["edges"];
} {
  return {
    nodes: input.nodes.filter((node) =>
      input.selection.nodeIds.includes(node.id)
    ),
    edges: input.edges.filter((edge) =>
      input.selection.edgeIds.includes(edge.id)
    ),
  };
}

/**
 * A Draft ordinary step selected alone. It offers Focus once its action is
 * chosen, because the action picker is all there is before that.
 */
export function matchStepSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "draft") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  const [onlyNode] = nodes;
  if (nodes.length !== 1 || edges.length > 0 || !isOrdinaryStep(onlyNode)) {
    return null;
  }
  return {
    kind: "step",
    workspace: input.workspace,
    key: `node:${onlyNode.id}`,
    nodeId: onlyNode.id,
    placement: { kind: "nodes", nodeIds: [onlyNode.id] },
    levels:
      typeof onlyNode.data.config?.actionType === "string"
        ? ["browse", "focus"]
        : ["browse"],
  };
}

/**
 * A Draft Condition selected alone. It offers Browse and Focus, and the camera
 * keeps its True and False outlets, and the labels that fit, in view with it.
 */
export function matchConditionSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "draft") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  const [onlyNode] = nodes;
  if (nodes.length !== 1 || edges.length > 0 || !isConditionNode(onlyNode)) {
    return null;
  }
  return {
    kind: "condition",
    workspace: input.workspace,
    key: `node:${onlyNode.id}`,
    nodeId: onlyNode.id,
    placement: { kind: "node-outlets", nodeId: onlyNode.id },
    levels: ["browse", "focus"],
  };
}

/**
 * A Draft Group frame selected alone, which the overview shows as a collapsed
 * card. Browse summarizes the Group and enters it; Focus holds the frame's
 * complete form.
 */
export function matchGroupSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "draft") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  const [onlyNode] = nodes;
  if (nodes.length !== 1 || edges.length > 0 || !isGroupNode(onlyNode)) {
    return null;
  }
  return {
    kind: "group",
    workspace: input.workspace,
    key: `node:${onlyNode.id}`,
    nodeId: onlyNode.id,
    placement: { kind: "nodes", nodeIds: [onlyNode.id] },
    levels: ["browse", "focus"],
  };
}

/**
 * The Draft Lifecycle Node selected alone: its policy summary in Browse and the
 * sectioned policy editor in Focus.
 */
export function matchLifecycleSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "draft") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  const [onlyNode] = nodes;
  if (
    nodes.length !== 1 ||
    edges.length > 0 ||
    onlyNode.data.type !== "lifecycle"
  ) {
    return null;
  }
  return {
    kind: "lifecycle",
    workspace: input.workspace,
    key: `node:${onlyNode.id}`,
    nodeId: onlyNode.id,
    placement: { kind: "nodes", nodeIds: [onlyNode.id] },
    levels: ["browse", "focus"],
  };
}

/**
 * Runs, at Browse only: the run list, or the run the route opens. It always
 * shows, placing the one selected node or else the whole graph.
 */
export function matchRunsSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "runs") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  const onlyNodeId =
    nodes.length === 1 && edges.length === 0 ? nodes[0].id : null;
  return {
    kind: "runs",
    workspace: input.workspace,
    key: onlyNodeId ? `node:${onlyNodeId}` : "graph",
    nodeId: onlyNodeId,
    placement: onlyNodeId
      ? { kind: "nodes", nodeIds: [onlyNodeId] }
      : { kind: "graph" },
    levels: ["browse"],
  };
}

/**
 * The Changes workspace, whatever it has selected. A single selected node or
 * connection is placed on the canvas and offers Browse and Focus, where its
 * before-and-after properties show. Any other selection places the whole
 * comparison graph and offers Browse alone.
 */
export function matchChangesSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "changes") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  const base = {
    kind: "changes" as const,
    workspace: input.workspace,
    levels: ["browse", "focus"] as const,
  };
  if (nodes.length === 1 && edges.length === 0) {
    return {
      ...base,
      key: `node:${nodes[0].id}`,
      nodeId: nodes[0].id,
      placement: { kind: "nodes", nodeIds: [nodes[0].id] },
    };
  }
  if (edges.length === 1 && nodes.length === 0) {
    return {
      ...base,
      key: `edge:${edges[0].id}`,
      nodeId: null,
      placement: {
        kind: "nodes",
        nodeIds: uniq([edges[0].source, edges[0].target]),
      },
    };
  }
  return {
    ...base,
    key: "graph",
    nodeId: null,
    placement: { kind: "graph" },
    levels: ["browse"],
  };
}

/**
 * The node config panel at Browse, in Draft alone: any selection no other kind
 * matches, such as an Event Split, a connection, or several objects.
 */
export function matchPanelSubject(
  input: RevealMatchInput
): RevealSubject | null {
  if (input.workspace !== "draft") {
    return null;
  }
  const { nodes, edges } = selectedGraph(input);
  if (nodes.length + edges.length === 0) {
    return null;
  }
  const onlyNodeId =
    nodes.length === 1 && edges.length === 0 ? nodes[0].id : null;
  return {
    kind: "panel",
    workspace: input.workspace,
    key: `selection:${nodes.map((node) => node.id).join(",")}|${edges.map((edge) => edge.id).join(",")}`,
    nodeId: onlyNodeId,
    placement: {
      kind: "nodes",
      nodeIds: uniq([
        ...nodes.map((node) => node.id),
        ...edges.flatMap((edge) => [edge.source, edge.target]),
      ]),
    },
    levels: ["browse"],
  };
}

/** The element id of the rule builder in a Condition's Focus body. */
export const CONDITION_RULES_TARGET_ID = "condition";

/**
 * The Condition config keys an issue can name. The rules a Condition stores
 * live under `condition` (the compiled CEL) or `conditionModel` (the rule
 * builder's own shape), and both are edited through the one rule builder
 * control.
 */
const CONDITION_RULE_FIELD_KEYS: ReadonlySet<string> = new Set([
  "condition",
  "conditionModel",
]);

/**
 * The element Canvas Reveal focuses in a Focus body for an issue naming
 * `fieldKey`, on a subject of kind `kind`. A Condition's two rule config keys
 * both resolve to its rule builder; every other kind focuses the field the
 * issue named. Both the issue list inside Reveal and the workflow issues
 * overlay route an issue click through this function, so a field opens the
 * same target from either place.
 */
export function revealFocusTarget(
  kind: RevealKindId,
  fieldKey: string
): string {
  return kind === "condition" && CONDITION_RULE_FIELD_KEYS.has(fieldKey)
    ? CONDITION_RULES_TARGET_ID
    : fieldKey;
}

/**
 * The level Canvas Reveal presents: closed with no subject, and otherwise the
 * stored level limited to the levels the subject offers.
 */
export function effectiveRevealLevel(
  stored: RevealLevel,
  subject: RevealSubject | null
): RevealLevel {
  if (subject === null) {
    return "closed";
  }
  if (stored === "closed" || subject.levels.includes(stored)) {
    return stored;
  }
  return subject.levels[0];
}
