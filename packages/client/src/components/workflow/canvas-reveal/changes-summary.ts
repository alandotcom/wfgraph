/**
 * What the Changes kind of Canvas Reveal reads: the comparison the active
 * address names and the state of its request, the header that identifies it,
 * the changed nodes and connections a person moves between, and what Focus
 * says about one of them. Everything except `comparisonRevealContextAtom` is
 * a pure function.
 */

import { compact, countBy } from "es-toolkit/array";
import { atom } from "jotai";
import { isBuiltInActionId } from "@wfgraph/shared/actions/built-in-actions";
import {
  findAction,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import {
  collectWorkflowIssues,
  type WorkflowIssue,
} from "@wfgraph/shared/graph/workflow-issues";
import { resolveEdgeLabel } from "#src/components/flow-elements/edge-label";
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
  type OpenRevealLevel,
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
 * The workspace address id whose change list takes DOM focus on its selected
 * row when it next mounts, or null. Back from Changes Focus sets it, so Browse
 * hands focus to the row of the object Focus showed.
 */
export const changeRowFocusRequestAtom = atom<string | null>(null);

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

/** The label of the Changes header's Focus toggle while Browse shows. */
const COMPARE_FIELDS_LABEL = "Compare fields";

/**
 * The Changes header. Its title names the comparison while one is shown and
 * stays the same while that comparison refreshes; the status says only what
 * the latest request is doing. At Focus the path ends with `inspectedTitle`,
 * the inspected object's title, and Back is offered to return to Browse.
 */
export function changesHeaderModel(input: {
  comparison: ComparisonRevealContext;
  workflowName: string;
  level: OpenRevealLevel;
  inspectedTitle: string | null;
}): RevealHeaderModel {
  const { comparison, level, inspectedTitle } = input;
  if (!("payload" in comparison)) {
    return {
      workspaceLabel: "Changes",
      title: TITLE_WITHOUT_COMPARISON[comparison.status],
      path: [],
      status: null,
      showsBack: level === "focus",
      focusLabel: COMPARE_FIELDS_LABEL,
    };
  }
  const title = comparisonTitle(comparison.payload);
  const trail =
    level === "focus"
      ? compact([inspectedTitle])
      : comparison.showsHistory
        ? ["Version history"]
        : [];
  return {
    workspaceLabel: "Changes",
    title,
    path: [input.workflowName || "Untitled workflow", title, ...trail],
    status: SHOWN_STATUS[comparison.status],
    showsBack: level === "focus",
    focusLabel: COMPARE_FIELDS_LABEL,
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

/**
 * A name for the comparison a payload holds. It changes exactly when Focus
 * must drop what it shows: another base, or another proposed version.
 */
export function comparisonIdentity(payload: WorkflowComparisonPayload): string {
  return `${payload.baseVersion?.id ?? "unpublished"}|${payload.proposedVersion}`;
}

/** The heading of the published side: "Version 3", or "No published version". */
export function comparisonBaseLabel(
  payload: WorkflowComparisonPayload
): string {
  return payload.baseVersion
    ? `Version ${payload.baseVersion.version}`
    : "No published version";
}

/** The heading of the draft side. */
export const COMPARISON_DRAFT_LABEL = "Current draft";

/**
 * What Focus shows for the selected object. A node carries its server change,
 * null when the node is unchanged, and the changed connections that touch it.
 * A connection carries the titles of the steps it joins and its branch label.
 * `unavailable` is an object the comparison graph does not hold.
 */
export type ChangeInspection =
  | {
      kind: "node";
      nodeId: string;
      change: ChangeKind | "unchanged";
      nodeChange: WorkflowNodeChange | null;
      title: string;
      connections: readonly ChangedObject[];
    }
  | {
      kind: "edge";
      edgeId: string;
      change: "added" | "removed" | "unchanged";
      title: string;
      source: string;
      target: string;
      /** The branch the connection leaves from, as "True", or null. */
      branch: string | null;
    }
  | { kind: "unavailable" };

/**
 * The inspection of `object` on the comparison canvas `graph`. `objects` is the
 * change list from `changedObjects`, which a node's connections are read from.
 */
export function inspectChange(input: {
  payload: WorkflowComparisonPayload;
  graph: ComparisonDisplayGraph;
  catalog: ExtensionCatalog;
  objects: readonly ChangedObject[];
  object: InspectedObject;
}): ChangeInspection {
  const { payload, graph, catalog, object } = input;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeTitle = (nodeId: string) => {
    const node = nodesById.get(nodeId);
    return node ? comparisonNodeTitle(node.data, catalog) : "Unavailable step";
  };
  if (object.kind === "node") {
    const node = nodesById.get(object.id);
    if (!node) {
      return { kind: "unavailable" };
    }
    const nodeChange =
      payload.nodeChanges.find((change) => change.nodeId === object.id) ?? null;
    const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
    return {
      kind: "node",
      nodeId: object.id,
      change: nodeChange?.kind ?? "unchanged",
      nodeChange,
      title: nodeChange
        ? changedNodeTitle(catalog, payload, nodeChange)
        : comparisonNodeTitle(node.data, catalog),
      connections: input.objects.filter((item) => {
        const edge =
          item.object.kind === "edge" ? edgesById.get(item.object.id) : null;
        return edge?.source === object.id || edge?.target === object.id;
      }),
    };
  }
  const edge = graph.edges.find((candidate) => candidate.id === object.id);
  if (!edge) {
    return { kind: "unavailable" };
  }
  const source = nodeTitle(edge.source);
  const target = nodeTitle(edge.target);
  return {
    kind: "edge",
    edgeId: edge.id,
    change: edge.data?.[COMPARISON_EDGE_ANNOTATION]?.kind ?? "unchanged",
    title: `${source} → ${target}`,
    source,
    target,
    branch: resolveEdgeLabel(edge.sourceHandle, edge.data),
  };
}

/**
 * The sentence under the inspected object's title: which sides hold it and
 * what changed.
 */
export function describeInspection(
  inspection: Exclude<ChangeInspection, { kind: "unavailable" }>,
  payload: WorkflowComparisonPayload
): string {
  const base = payload.baseVersion
    ? `version ${payload.baseVersion.version}`
    : "any published version";
  if (inspection.kind === "edge") {
    return {
      added: `This connection is new in the draft. It is not in ${base}.`,
      removed: `This connection is removed from the draft. Only ${base} has it.`,
      unchanged: `This connection is the same in ${base} and the draft.`,
    }[inspection.change];
  }
  switch (inspection.change) {
    case "added":
      return `This step is new in the draft. It is not in ${base}, so only the draft's values are shown.`;
    case "removed":
      return `This step is removed from the draft. Only ${base} has values for it.`;
    case "modified": {
      const count = inspection.nodeChange?.fields.length ?? 0;
      return `${count} ${count === 1 ? "setting differs" : "settings differ"} between ${base} and the draft.`;
    }
    default:
      return inspection.connections.length > 0
        ? `This step's settings are the same in ${base} and the draft. Only its connections changed.`
        : `This step is the same in ${base} and the draft.`;
  }
}

/**
 * What validation says about one side's copy of a node: `absent` when that
 * side does not hold the node, `unknown` when the node's action is missing from
 * the catalog so its settings cannot be checked, and otherwise its issues.
 */
export type NodeValidationSide =
  | { kind: "absent" }
  | { kind: "unknown" }
  | { kind: "checked"; issues: readonly WorkflowIssue[] };

type GraphIssues = {
  nodes: ReadonlyMap<string, WorkflowNode>;
  issuesByNode: ReadonlyMap<string, readonly WorkflowIssue[]>;
};

const graphIssuesCache = new WeakMap<
  WorkflowComparisonPayload,
  WeakMap<ExtensionCatalog, { before: GraphIssues; after: GraphIssues }>
>();

/**
 * Every issue the editor's checks find in one graph, grouped by node id.
 * Missing-connection issues are left out, since a published version's
 * connections are not part of the comparison.
 */
function graphIssues(
  serialized: WorkflowComparisonPayload["baseGraph"],
  catalog: ExtensionCatalog
): GraphIssues {
  const graph = toWorkflowGraphData(serialized);
  const issues = collectWorkflowIssues({
    nodes: graph.nodes,
    edges: graph.edges,
    catalog,
    integrations: [],
  }).filter((issue) => issue.kind !== "missing_integration");
  return {
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    issuesByNode: Map.groupBy(issues, (issue) => issue.nodeId),
  };
}

/** Both graphs' issues for `payload` checked against `catalog`, computed once. */
function comparisonIssues(
  payload: WorkflowComparisonPayload,
  catalog: ExtensionCatalog
): { before: GraphIssues; after: GraphIssues } {
  let byCatalog = graphIssuesCache.get(payload);
  if (!byCatalog) {
    byCatalog = new WeakMap();
    graphIssuesCache.set(payload, byCatalog);
  }
  const cached = byCatalog.get(catalog);
  if (cached) {
    return cached;
  }
  const computed = {
    before: graphIssues(payload.baseGraph, catalog),
    after: graphIssues(payload.draftGraph, catalog),
  };
  byCatalog.set(catalog, computed);
  return computed;
}

function validationSide(
  graph: GraphIssues,
  nodeId: string,
  catalog: ExtensionCatalog
): NodeValidationSide {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    return { kind: "absent" };
  }
  const actionType = actionTypeOf(node);
  if (
    actionType !== undefined &&
    !isBuiltInActionId(actionType) &&
    findAction(catalog, actionType) === undefined
  ) {
    return { kind: "unknown" };
  }
  return { kind: "checked", issues: graph.issuesByNode.get(nodeId) ?? [] };
}

/**
 * The validation of node `nodeId` in the published graph and in the draft
 * graph, each checked by the editor's issue checks against the catalog
 * available now. Missing-connection issues are left out of both sides.
 */
export function nodeValidationSides(input: {
  payload: WorkflowComparisonPayload;
  nodeId: string;
  catalog: ExtensionCatalog;
}): { before: NodeValidationSide; after: NodeValidationSide } {
  const { before, after } = comparisonIssues(input.payload, input.catalog);
  return {
    before: validationSide(before, input.nodeId, input.catalog),
    after: validationSide(after, input.nodeId, input.catalog),
  };
}

/**
 * What tells two issues of one node apart across the published and draft
 * sides. It is built from the issue's structured fields, so an issue keeps its
 * identity when the node is renamed and its message changes with the label.
 */
export function issueIdentity(issue: WorkflowIssue): string {
  if (
    issue.kind === "missing_required_field" ||
    issue.kind === "unverified_provider_field"
  ) {
    return `${issue.kind}|${issue.fieldKey}`;
  }
  if (issue.kind === "broken_reference") {
    return `${issue.kind}|${issue.fieldKey}|${issue.referencedNodeId}|${issue.displayText}`;
  }
  if (issue.kind === "missing_integration") {
    return `${issue.kind}|${issue.integrationType}`;
  }
  if (issue.kind === "invalid_group") {
    return `${issue.kind}|${issue.rule}`;
  }
  return `${issue.kind}|${issue.check}`;
}

function issueCount(count: number): string {
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

/** The sentence about one side when the other side cannot be compared with it. */
function describeValidationSide(
  side: NodeValidationSide,
  version: "published" | "draft"
): string | undefined {
  if (side.kind === "absent") {
    return undefined;
  }
  if (side.kind === "unknown") {
    return version === "published"
      ? "Validation of the published step is unknown, because its action is not available in this editor."
      : "Validation of the draft's step is unknown, because its action is not available in this editor.";
  }
  const count =
    side.issues.length === 0 ? "no issues" : issueCount(side.issues.length);
  return version === "published"
    ? `The published step had ${count}.`
    : `The draft's step has ${count}.`;
}

/**
 * How the node's validation differs between the sides: the issues the draft
 * adds and resolves, or that both sides agree. When a side does not hold the
 * node or cannot be checked, each side is described alone.
 */
export function describeValidationDifference(input: {
  before: NodeValidationSide;
  after: NodeValidationSide;
}): string {
  const { before, after } = input;
  if (before.kind !== "checked" || after.kind !== "checked") {
    const sentences = compact([
      describeValidationSide(before, "published"),
      describeValidationSide(after, "draft"),
    ]);
    return sentences.length === 0
      ? "The draft's step has no issues."
      : sentences.join(" ");
  }
  const beforeIds = new Set(before.issues.map(issueIdentity));
  const afterIds = new Set(after.issues.map(issueIdentity));
  const added = after.issues.filter(
    (issue) => !beforeIds.has(issueIdentity(issue))
  ).length;
  const resolved = before.issues.filter(
    (issue) => !afterIds.has(issueIdentity(issue))
  ).length;
  if (added === 0 && resolved === 0) {
    return after.issues.length === 0
      ? "No issues in either version."
      : "Validation is the same in both versions.";
  }
  const parts = compact([
    added > 0 ? `adds ${issueCount(added)}` : undefined,
    resolved > 0 ? `resolves ${issueCount(resolved)}` : undefined,
  ]);
  return `The draft ${parts.join(" and ")}.`;
}
