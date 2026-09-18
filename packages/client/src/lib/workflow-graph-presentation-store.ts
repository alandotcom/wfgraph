/**
 * Read-only canvas presentation derived from draft, run, comparison, and
 * selection state.
 * Draft mutation and history remain in `workflow-graph-store`.
 */

import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { isEqual } from "es-toolkit/predicate";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { mapOrSame } from "@wfgraph/shared/utils/map-or-same";
import { inactiveBranch } from "#src/lib/inactive-branch";
import {
  EMPTY_ISSUES,
  workflowIssuesByNodeIdAtom,
} from "#src/lib/workflow-issues-store";
import {
  displayEdgesForGroups,
  groupOutletHandles,
  orderGroupParentsFirst,
} from "@wfgraph/shared/graph/node-group";
import { lockGroupInteriorEdges } from "#src/lib/node-group";
import {
  edgesStateAtom,
  executionOverlayGraphAtom,
  nodesStateAtom,
} from "#src/lib/workflow-graph-cells";
import {
  graphStructureKey,
  type NavigationGraph,
} from "#src/lib/workflow-navigation-state";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import { isPublicationReviewActiveAtom } from "#src/lib/workflow-publication-review-store";
import {
  isGeneratingAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import type {
  NodeIssueSummary,
  NodeRunStatus,
  WorkflowEdge,
  WorkflowNode,
} from "#src/lib/workflow-graph-types";

/** Run status by node id, separate from every persisted graph. */
const statusByNodeIdAtom = atom<ReadonlyMap<string, NodeRunStatus>>(new Map());

/** Whether the canvas is showing a run's pinned graph instead of the draft. */
export const isExecutionOverlayActiveAtom = atom(
  (get) => get(executionOverlayGraphAtom) !== null
);

/** Whether anything other than the editable draft owns the canvas. */
export const canvasEditingLockedAtom = atom(
  (get) =>
    get(isGeneratingAtom) ||
    get(workflowWorkspaceViewAtom) !== "draft" ||
    get(isPublicationReviewActiveAtom)
);

/**
 * The graph the active workspace presents before any paint: the Draft, the
 * open run's pinned graph, or the comparison graph. Null while Runs or Changes
 * is waiting for its graph.
 */
export const presentedGraphAtom = atom(
  (get): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } | null => {
    const view = get(workflowWorkspaceViewAtom);
    if (view === "runs") {
      return get(executionOverlayGraphAtom);
    }
    if (view === "changes") {
      return get(comparisonDisplayGraphAtom);
    }
    return { nodes: get(nodesStateAtom), edges: get(edgesStateAtom) };
  }
);

/** A presented graph and its `graphStructureKey`. */
export type PresentedGraphStructure = {
  graph: NavigationGraph;
  key: string;
};

/**
 * The presented graph's structure, or null while `presentedGraphAtom` is null.
 * The value stays the same object while the structure key is unchanged, so a
 * drag that only moves nodes notifies no subscriber. Its graph keeps the
 * positions of the last structural change, so a reader takes only node ids,
 * kinds, parents, and edge ids from it.
 */
export const presentedGraphStructureAtom = selectAtom(
  presentedGraphAtom,
  (graph): PresentedGraphStructure | null =>
    graph ? { graph, key: graphStructureKey(graph) } : null,
  (left, right) => left?.key === right?.key
);

const inactiveBranchAtom = atom((get) => {
  const view = get(workflowWorkspaceViewAtom);
  const overlay = view === "runs" ? get(executionOverlayGraphAtom) : null;
  const comparison =
    view === "changes" ? get(comparisonDisplayGraphAtom) : null;
  if (comparison) {
    return { nodeIds: new Set<string>(), outletEdgeIds: new Set<string>() };
  }
  const nodes = overlay?.nodes ?? get(nodesStateAtom);
  const edges = overlay?.edges ?? get(edgesStateAtom);
  return inactiveBranch({ nodes, edges });
});

const INACTIVE_NODE_STYLE = { opacity: 0.5 } as const;

type PaintedNode = {
  status: NodeRunStatus | undefined;
  muted: boolean;
  issues: NodeIssueSummary | undefined;
  painted: WorkflowNode;
};

const paintedNodes = new WeakMap<WorkflowNode, PaintedNode>();

/** The copy of each node or edge whose `selected` flag differs from its own. */
const flaggedNodes = new WeakMap<WorkflowNode, WorkflowNode>();
const flaggedEdges = new WeakMap<WorkflowEdge, WorkflowEdge>();

/**
 * `item` with its `selected` flag equal to `selected`. A flipped copy is cached
 * per item, so an unchanged selection keeps element identity across repaints.
 */
function withSelectedFlag<T extends { selected?: boolean | undefined }>(
  item: T,
  selected: boolean,
  cache: WeakMap<T, T>
): T {
  if (Boolean(item.selected) === selected) {
    return item;
  }
  const cached = cache.get(item);
  if (cached && Boolean(cached.selected) === selected) {
    return cached;
  }
  const flagged = { ...item, selected };
  cache.set(item, flagged);
  return flagged;
}

/** Nodes painted for the active workspace without modifying the stored graph. */
export const displayNodesAtom = atom((get) => {
  const view = get(workflowWorkspaceViewAtom);
  const overlay = view === "runs" ? get(executionOverlayGraphAtom) : null;
  const comparison =
    view === "changes" ? get(comparisonDisplayGraphAtom) : null;
  const displayGraph = view === "runs" ? overlay : comparison;
  const nodes = displayGraph?.nodes ?? get(nodesStateAtom);
  const statusByNodeId = get(statusByNodeIdAtom);
  const { nodeIds } = get(inactiveBranchAtom);
  const ordered = orderGroupParentsFirst(nodes);
  const issuesByNodeId = displayGraph
    ? EMPTY_ISSUES
    : get(workflowIssuesByNodeIdAtom);
  const selectedIds = new Set(get(activeSelectionAtom).nodeIds);
  const paintSelection = (items: WorkflowNode[]) =>
    mapOrSame(items, (node) =>
      withSelectedFlag(node, selectedIds.has(node.id), flaggedNodes)
    );

  if (
    statusByNodeId.size === 0 &&
    nodeIds.size === 0 &&
    issuesByNodeId.size === 0
  ) {
    return paintSelection(ordered);
  }

  const paintingRun =
    (overlay !== null || comparison === null) && statusByNodeId.size > 0;
  const painted = ordered.map((node) => {
    const muted = nodeIds.has(node.id) && node.data.enabled !== false;
    const issues = issuesByNodeId.get(node.id);

    if (!(paintingRun || muted || issues)) {
      return node;
    }

    const status = paintingRun
      ? (statusByNodeId.get(node.id) ?? "idle")
      : undefined;
    const cached = paintedNodes.get(node);
    if (
      cached &&
      cached.status === status &&
      cached.muted === muted &&
      cached.issues === issues
    ) {
      return cached.painted;
    }

    // The paint is spread over the stored data rather than merged into the
    // same literal: `omitUndefined` drops the keys this paint has nothing to
    // say about, so the node keeps its own `status` and `issues`,
    // and it reads only string keys, so a symbol such as the comparison
    // annotation survives outside it.
    const withStatus: WorkflowNode = {
      ...node,
      data: {
        ...node.data,
        ...omitUndefined({ status, issues }),
      },
    };
    const paintedNode = muted
      ? {
          ...withStatus,
          style: { ...withStatus.style, ...INACTIVE_NODE_STYLE },
        }
      : withStatus;

    paintedNodes.set(node, {
      status,
      muted,
      issues,
      painted: paintedNode,
    });
    return paintedNode;
  });

  return paintSelection(painted);
});

/** Edges painted for the active workspace without modifying the stored graph. */
export const displayEdgesAtom = atom((get) => {
  const view = get(workflowWorkspaceViewAtom);
  const overlay = view === "runs" ? get(executionOverlayGraphAtom) : null;
  const comparison =
    view === "changes" ? get(comparisonDisplayGraphAtom) : null;
  const selectedIds = new Set(get(activeSelectionAtom).edgeIds);
  const paintSelection = (items: WorkflowEdge[]) =>
    mapOrSame(items, (edge) =>
      withSelectedFlag(edge, selectedIds.has(edge.id), flaggedEdges)
    );
  if (comparison) {
    return paintSelection(comparison.edges);
  }
  const nodes = overlay?.nodes ?? get(nodesStateAtom);
  const edges = overlay?.edges ?? get(edgesStateAtom);
  const painted = lockGroupInteriorEdges(
    nodes,
    displayEdgesForGroups(nodes, edges)
  );
  const { nodeIds, outletEdgeIds } = get(inactiveBranchAtom);
  const withInactiveBranch =
    nodeIds.size === 0
      ? painted
      : mapOrSame(painted, (edge) => {
          if (!nodeIds.has(edge.target)) {
            return edge;
          }
          return {
            ...edge,
            data: omitUndefined({
              ...edge.data,
              inactive: true,
              displayLabel: outletEdgeIds.has(edge.id)
                ? "No Cancel Event"
                : undefined,
            }),
          };
        });
  return paintSelection(withInactiveBranch);
});

/**
 * The graph the canvas paints Group frames from: the presented graph, or the
 * Draft while Runs or Changes is waiting for its graph, the same fallback
 * `displayNodesAtom` paints.
 */
const canvasGraphAtom = atom(
  (get) =>
    get(presentedGraphAtom) ?? {
      nodes: get(nodesStateAtom),
      edges: get(edgesStateAtom),
    }
);

/**
 * An atom holding the source handle ids the Group frame `groupId` draws, read
 * from the presented graph's member edges. It keeps the same array while the
 * handles are unchanged, so dragging a node re-renders no frame. Create it once
 * per frame id, because each call makes a new atom.
 */
export function groupOutletHandlesAtom(groupId: string) {
  return selectAtom(
    canvasGraphAtom,
    (graph) => groupOutletHandles(graph.nodes, graph.edges, groupId),
    isEqual
  );
}

/** Reset run badges and drop the pinned graph after deleting runs. */
export const clearNodeStatusesAtom = atom(null, (_get, set) => {
  set(executionOverlayGraphAtom, null);
  set(statusByNodeIdAtom, new Map());
});

/** Reset run badges while retaining the pinned graph for the next run. */
export const resetNodeStatusesAtom = atom(null, (_get, set) => {
  set(statusByNodeIdAtom, new Map());
});

/** Merge a run's progress onto whichever graph the workspace presents. */
export const setNodeStatusesAtom = atom(
  null,
  (get, set, statuses: Array<{ nodeId: string; status: NodeRunStatus }>) => {
    if (statuses.length === 0) {
      return;
    }

    const current = get(statusByNodeIdAtom);
    const next = new Map(current);
    let hasUpdates = false;
    for (const { nodeId, status } of statuses) {
      if (current.get(nodeId) !== status) {
        next.set(nodeId, status);
        hasUpdates = true;
      }
    }

    if (hasUpdates) {
      set(statusByNodeIdAtom, next);
    }
  }
);
