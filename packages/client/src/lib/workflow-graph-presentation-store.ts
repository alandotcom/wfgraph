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
  groupIssues,
  sameSummary,
  summarizeNodeIssues,
  workflowIssuesAtom,
  workflowIssuesByNodeIdAtom,
} from "#src/lib/workflow-issues-store";
import {
  childIdsOfGroup,
  groupOutletHandles,
  orderGroupParentsFirst,
} from "@wfgraph/shared/graph/node-group";
import { scopeCanvasGraph } from "#src/lib/group-scope-canvas";
import {
  edgesStateAtom,
  executionOverlayGraphAtom,
  nodesStateAtom,
} from "#src/lib/workflow-graph-cells";
import {
  graphStructureKey,
  type NavigationGraph,
} from "#src/lib/workflow-navigation-state";
import {
  activeSelectionAtom,
  activeWorkspaceAddressAtom,
} from "#src/lib/workflow-workspace-navigation";
import { comparisonDisplayGraphAtom } from "#src/lib/workflow-comparison-store";
import { isPublicationReviewActiveAtom } from "#src/lib/workflow-publication-review-store";
import {
  isGeneratingAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import type { RunNodeEvidenceStatus } from "@wfgraph/shared/graph/group-run-status";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  NodeIssueSummary,
  NodeRunStatus,
  WorkflowEdge,
  WorkflowNode,
} from "#src/lib/workflow-graph-types";

/**
 * Run evidence status by node id, separate from every persisted graph. Step
 * cards paint from it and a Group's run summary is counted from it, so both
 * read one value per node.
 */
const statusByNodeIdAtom = atom<ReadonlyMap<string, RunNodeEvidenceStatus>>(
  new Map()
);

/** The open run's own status, written with its node statuses. */
const runExecutionStatusAtom = atom<WorkflowExecutionStatus | null>(null);

/** The run evidence status of each node the open run's progress names. */
export const runNodeEvidenceStatusesAtom = atom((get) =>
  get(statusByNodeIdAtom)
);

/** The status of the run whose progress is projected, or null before one is. */
export const projectedRunStatusAtom = atom((get) =>
  get(runExecutionStatusAtom)
);

/**
 * What a step card paints for a node's evidence. A node the run has not reached
 * and a node it reached with no further progress both paint as idle.
 */
function paintedRunStatus(evidence: RunNodeEvidenceStatus): NodeRunStatus {
  return evidence === "none" || evidence === "pending" ? "idle" : evidence;
}

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

/** The Group summaries handed out last time, so an unchanged Group keeps its identity. */
let lastGroupIssueSummaries: ReadonlyMap<string, NodeIssueSummary> = new Map();

/**
 * The issue badge each Draft node wears on the canvas. A Group member's issues
 * also count toward its Group's badge, because the collapsed card hides the
 * member. A Group whose badge is unchanged keeps the same summary object, so
 * its card is not painted again.
 */
export const canvasIssuesByNodeIdAtom = atom((get) => {
  const byNode = get(workflowIssuesByNodeIdAtom);
  if (byNode.size === 0) {
    return byNode;
  }
  const issues = get(workflowIssuesAtom);
  const nodes = get(nodesStateAtom);
  const parentById = new Map(
    nodes.flatMap((node) =>
      node.parentId === undefined ? [] : [[node.id, node.parentId] as const]
    )
  );
  const groupIds = new Set(
    issues.flatMap((issue) => {
      const parentId = parentById.get(issue.nodeId);
      return parentId === undefined ? [] : [parentId];
    })
  );
  if (groupIds.size === 0) {
    lastGroupIssueSummaries = new Map();
    return byNode;
  }
  const groupSummaries = new Map(
    [...groupIds].map((groupId) => {
      const summary = summarizeNodeIssues(
        groupIssues({ issues, nodes, groupId })
      );
      const previous = lastGroupIssueSummaries.get(groupId);
      return [
        groupId,
        previous && sameSummary(previous, summary) ? previous : summary,
      ] as const;
    })
  );
  lastGroupIssueSummaries = groupSummaries;
  return new Map([...byNode, ...groupSummaries]);
});

/**
 * Every node of the active workspace, painted without modifying the stored
 * graph, whichever scope the canvas shows.
 */
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
    : get(canvasIssuesByNodeIdAtom);
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
      ? paintedRunStatus(statusByNodeId.get(node.id) ?? "none")
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

/**
 * The stored edges of the active workspace, painted with inactive branches and
 * selection, before `scopeCanvasGraph` places them on Group frames or stubs.
 */
const paintedEdgesAtom = atom((get) => {
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
  const edges = overlay?.edges ?? get(edgesStateAtom);
  const { nodeIds, outletEdgeIds } = get(inactiveBranchAtom);
  const withInactiveBranch =
    nodeIds.size === 0
      ? edges
      : mapOrSame(edges, (edge) => {
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
 * What the canvas paints for the active scope: the overview with each Group
 * collapsed, or one focused Group's members and boundary stubs. Painting reads
 * the stored graph and never writes to it.
 */
export const canvasGraphAtom = atom((get) =>
  scopeCanvasGraph({
    nodes: get(displayNodesAtom),
    edges: get(paintedEdgesAtom),
    scope: get(activeWorkspaceAddressAtom).scope,
  })
);

/** The nodes the canvas paints for the active scope. */
export const canvasNodesAtom = atom((get) => get(canvasGraphAtom).nodes);

/** The edges the canvas paints for the active scope. */
export const canvasEdgesAtom = atom((get) => get(canvasGraphAtom).edges);

/**
 * The graph the canvas paints Group frames from: the presented graph, or the
 * Draft while Runs or Changes is waiting for its graph, the same fallback
 * `displayNodesAtom` paints.
 */
const frameSourceGraphAtom = atom(
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
    frameSourceGraphAtom,
    (graph) => groupOutletHandles(graph.nodes, graph.edges, groupId),
    isEqual
  );
}

/**
 * An atom holding how many members the Group frame `groupId` holds in the
 * presented graph. Create it once per frame id, because each call makes a new
 * atom.
 */
export function groupMemberCountAtom(groupId: string) {
  return selectAtom(
    frameSourceGraphAtom,
    (graph) => childIdsOfGroup(graph.nodes, groupId).length
  );
}

/** Reset run badges and drop the pinned graph after deleting runs. */
export const clearNodeStatusesAtom = atom(null, (_get, set) => {
  set(executionOverlayGraphAtom, null);
  set(statusByNodeIdAtom, new Map());
  set(runExecutionStatusAtom, null);
});

/** Reset run badges while retaining the pinned graph for the next run. */
export const resetNodeStatusesAtom = atom(null, (_get, set) => {
  set(statusByNodeIdAtom, new Map());
  set(runExecutionStatusAtom, null);
});

/** Merge a run's progress onto whichever graph the workspace presents. */
export const setNodeStatusesAtom = atom(
  null,
  (
    get,
    set,
    statuses: Array<{ nodeId: string; status: RunNodeEvidenceStatus }>
  ) => {
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

/**
 * Replace the projected run progress with one status read: the run's own
 * status and every node status the read names. Null projects no run, which
 * clears every node status.
 */
export const projectRunProgressAtom = atom(
  null,
  (
    _get,
    set,
    snapshot: {
      executionStatus: WorkflowExecutionStatus;
      statuses: Array<{ nodeId: string; status: RunNodeEvidenceStatus }>;
    } | null
  ) => {
    set(runExecutionStatusAtom, snapshot?.executionStatus ?? null);
    set(
      statusByNodeIdAtom,
      new Map(
        (snapshot?.statuses ?? []).map(({ nodeId, status }) => [nodeId, status])
      )
    );
  }
);
