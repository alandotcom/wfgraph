/**
 * What the Changes kind of Canvas Reveal reads: the comparison the active
 * address names and the state of its request, the header that identifies it,
 * and the changed nodes and connections a person moves between. Everything
 * except `comparisonRevealContextAtom` is a pure function.
 */

import { countBy } from "es-toolkit/array";
import { atom } from "jotai";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import { changedNodeTitle } from "#src/components/workflow/comparison-properties";
import type { ComparisonDisplayGraph } from "#src/lib/workflow-comparison";
import {
  comparisonRequestBaseIdAtom,
  comparisonSessionAtom,
  comparisonShowsBase,
  isComparisonErrorAtom,
  isComparisonPendingAtom,
  routeComparisonBaseIdAtom,
  type WorkflowComparisonSession,
} from "#src/lib/workflow-comparison-store";
import {
  COMPARISON_EDGE_ANNOTATION,
  comparisonNodeTitle,
} from "#src/lib/workflow-graph-types";
import {
  selectedObject,
  type CanvasSelection,
  type InspectedObject,
} from "#src/lib/workflow-navigation-state";
import type { RevealHeaderModel } from "./reveal-header";

/** The comparison states that have no comparison to show yet. */
export type ComparisonWaitingStatus = "idle" | "loading" | "error";

/**
 * The comparison states that show the installed comparison: `refreshing` while
 * a request for the same comparison runs, and `refresh-failed` after it failed.
 */
export type ComparisonShownStatus = "ready" | "refreshing" | "refresh-failed";

/**
 * Where the comparison the address names stands. The installed comparison is
 * present exactly when it is the one the address names, so a comparison
 * against another base is never shown as this one.
 */
export type ComparisonRevealContext =
  | { status: ComparisonWaitingStatus }
  | {
      status: ComparisonShownStatus;
      payload: WorkflowComparisonPayload;
      /** Whether version history is open in place of the change list. */
      showsHistory: boolean;
    };

/**
 * The comparison state for an address naming `baseVersionId`. A null
 * `baseVersionId` names no base yet, so any installed comparison is the one it
 * shows; route recovery then writes that comparison's base into the route.
 * `pending` and `failed` describe the latest request, which counts only when it
 * named this base or named none.
 */
export function comparisonRevealContext(input: {
  baseVersionId: string | null;
  session: WorkflowComparisonSession | null;
  requestBaseVersionId: string | null;
  pending: boolean;
  failed: boolean;
}): ComparisonRevealContext {
  const { session, baseVersionId, requestBaseVersionId } = input;
  const requestApplies =
    baseVersionId === null ||
    requestBaseVersionId === null ||
    requestBaseVersionId === baseVersionId;
  const pending = input.pending && requestApplies;
  const failed = input.failed && requestApplies;
  if (session === null || !comparisonShowsBase(session, baseVersionId)) {
    return { status: pending ? "loading" : failed ? "error" : "idle" };
  }
  return {
    status: pending ? "refreshing" : failed ? "refresh-failed" : "ready",
    payload: session.payload,
    showsHistory: session.subview === "history",
  };
}

/** The comparison state of the active address of the open workflow. */
export const comparisonRevealContextAtom = atom(
  (get): ComparisonRevealContext =>
    comparisonRevealContext({
      baseVersionId: get(routeComparisonBaseIdAtom),
      session: get(comparisonSessionAtom),
      requestBaseVersionId: get(comparisonRequestBaseIdAtom),
      pending: get(isComparisonPendingAtom),
      failed: get(isComparisonErrorAtom),
    })
);

/**
 * The name of a comparison: the published version it starts from and the
 * version number publishing the draft would take, as "Version 3 → proposed
 * version 4".
 */
export function comparisonTitle(payload: WorkflowComparisonPayload): string {
  const base = payload.baseVersion
    ? `Version ${payload.baseVersion.version}`
    : "No published version";
  return `${base} → proposed version ${payload.proposedVersion}`;
}

const TITLE_WITHOUT_COMPARISON: Record<ComparisonWaitingStatus, string> = {
  idle: "No comparison open",
  loading: "Comparing changes",
  error: "Comparison unavailable",
};

const SHOWN_STATUS: Record<ComparisonShownStatus, RevealHeaderModel["status"]> =
  {
    ready: null,
    refreshing: { text: "Refreshing", tone: "muted" },
    "refresh-failed": { text: "Refresh failed", tone: "warning" },
  };

/**
 * The Changes header. Its title names the comparison while one is shown and
 * stays the same while that comparison refreshes; the status says only what
 * the latest request is doing.
 */
export function changesHeaderModel(input: {
  comparison: ComparisonRevealContext;
  workflowName: string;
}): RevealHeaderModel {
  const { comparison } = input;
  if (!("payload" in comparison)) {
    return {
      workspaceLabel: "Changes",
      title: TITLE_WITHOUT_COMPARISON[comparison.status],
      path: [],
      status: null,
      showsBack: false,
    };
  }
  const title = comparisonTitle(comparison.payload);
  return {
    workspaceLabel: "Changes",
    title,
    path: [
      input.workflowName || "Untitled workflow",
      title,
      ...(comparison.showsHistory ? ["Version history"] : []),
    ],
    status: SHOWN_STATUS[comparison.status],
    showsBack: false,
  };
}

export type ChangeKind = WorkflowNodeChange["kind"];

/** One changed node or connection, as the change list shows it. */
export type ChangedObject = {
  /** Unique in the list: the object's kind and its canvas id. */
  key: string;
  /** The node or edge on the comparison canvas, by its display id. */
  object: InspectedObject;
  change: ChangeKind;
  title: string;
};

/**
 * The changed nodes in the order the server lists them, then the changed
 * connections. A connection is named by its display edge on `graph`, since a
 * removed connection can be drawn under an id of its own, and by the titles of
 * the steps it joins. A change with no display edge is left out.
 */
export function changedObjects(input: {
  payload: WorkflowComparisonPayload;
  graph: ComparisonDisplayGraph;
  catalog: ExtensionCatalog;
}): ChangedObject[] {
  const { payload, graph, catalog } = input;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeTitle = (nodeId: string) => {
    const node = nodesById.get(nodeId);
    return node ? comparisonNodeTitle(node.data, catalog) : "Unavailable step";
  };
  const nodes = payload.nodeChanges.map((change): ChangedObject => ({
    key: `node:${change.nodeId}`,
    object: { kind: "node", id: change.nodeId },
    change: change.kind,
    title: changedNodeTitle(catalog, payload, change),
  }));
  const edges = payload.edgeChanges.flatMap((change): ChangedObject[] => {
    const edge = graph.edges.find((candidate) => {
      const annotation = candidate.data?.[COMPARISON_EDGE_ANNOTATION];
      return (
        annotation?.sourceId === change.edgeId &&
        annotation.kind === change.kind
      );
    });
    return edge
      ? [
          {
            key: `edge:${edge.id}`,
            object: { kind: "edge", id: edge.id },
            change: change.kind,
            title: `${nodeTitle(edge.source)} → ${nodeTitle(edge.target)}`,
          },
        ]
      : [];
  });
  return [...nodes, ...edges];
}

/** The index of the one selected object in `objects`, or -1. */
export function selectedChangeIndex(
  objects: readonly ChangedObject[],
  selection: CanvasSelection
): number {
  const selected = selectedObject(selection);
  return selected === null
    ? -1
    : objects.findIndex(
        (item) =>
          item.object.kind === selected.kind && item.object.id === selected.id
      );
}

/** The selection holding only one changed object. */
export function changeSelection(object: InspectedObject): CanvasSelection {
  return object.kind === "node"
    ? { nodeIds: [object.id], edgeIds: [] }
    : { nodeIds: [], edgeIds: [object.id] };
}

/**
 * How many changes of each kind a list holds, as "1 added, 2 removed", or
 * "No changes" for none.
 */
export function describeChangeCounts(
  changes: ReadonlyArray<{ kind: ChangeKind }>
): string {
  const counts = countBy(changes, (change) => change.kind);
  const parts = (["added", "modified", "removed"] as const).flatMap((kind) =>
    counts[kind] ? [`${counts[kind]} ${kind}`] : []
  );
  return parts.length === 0 ? "No changes" : parts.join(", ");
}
