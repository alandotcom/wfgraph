/**
 * The subjects Canvas Reveal can show, and the pure rules that recognize each
 * kind in a selection. `reveal-kinds.tsx` pairs each rule with what the shell
 * renders for that kind.
 */

import { uniq } from "es-toolkit/array";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import type {
  CanvasSelection,
  OpenRevealLevel,
  RevealLevel,
  WorkspaceView,
} from "#src/lib/workflow-navigation-state";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export type RevealKindId = "step" | "panel";

/**
 * What the camera keeps in view while Reveal shows a subject: listed nodes,
 * the whole presented graph, or nothing.
 */
export type RevealPlacement =
  | { kind: "nodes"; nodeIds: readonly string[] }
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
 * The node config panel at Browse. In Runs and Changes it always shows, placing
 * the one selected node or else the whole graph. In Draft it shows any other
 * selection the graph holds: a Condition, Lifecycle, Event Split, Group,
 * connection, or several objects.
 */
export function matchPanelSubject(
  input: RevealMatchInput
): RevealSubject | null {
  const { nodes, edges } = selectedGraph(input);
  const onlyNodeId =
    nodes.length === 1 && edges.length === 0 ? nodes[0].id : null;
  if (input.workspace !== "draft") {
    return {
      kind: "panel",
      workspace: input.workspace,
      key: onlyNodeId ? `node:${onlyNodeId}` : "graph",
      nodeId: onlyNodeId,
      placement: onlyNodeId
        ? { kind: "nodes", nodeIds: [onlyNodeId] }
        : { kind: "graph" },
      levels: ["browse"],
    };
  }
  if (nodes.length + edges.length === 0) {
    return null;
  }
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
