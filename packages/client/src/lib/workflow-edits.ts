/**
 * The edits a person made between two versions of a workflow, read from the
 * comparison the server returns. One edit stands for one added, modified or
 * removed step, or for a step whose continuation changed between steps that
 * both still exist. A connection that exists only because a step was added or
 * removed is part of that step's edit. Changes that leave every run the same,
 * a Group's own settings and a step moving between Groups, are listed apart.
 * Everything here is pure, and every word is a label the builder or the
 * catalog wrote, never an id.
 */

import { compact, uniq } from "es-toolkit/array";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  isGroupFrameChange,
  isGroupMembershipPath,
} from "@wfgraph/shared/graph/change-classification";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { outletName } from "@wfgraph/shared/graph/workflow-outline";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  comparisonFields,
  isConditionRulesRow,
} from "#src/components/workflow/comparison-properties";
import { comparisonNodeTitle } from "#src/lib/workflow-graph-types";

/** The comparison fields the edits are read from. */
export type EditsComparison = Pick<
  WorkflowComparisonPayload,
  "baseGraph" | "draftGraph" | "nodeChanges" | "edgeChanges"
>;

/** A step beside the edited step on its strip, and the branch between them. */
export type StripStep = {
  nodeId: string;
  label: string;
  /**
   * The outlet name of the connection joining this step to the edited one,
   * such as "True" or an Event's name, or null for an unnamed outlet.
   */
  branch: string | null;
};

/**
 * Where an edit sits on the path, in words: the Group holding the step, the
 * steps that lead into it, and the steps it continues to. An empty `after`
 * means the path ends at the step.
 */
export type EditStrip = {
  group: string | null;
  before: readonly StripStep[];
  after: readonly StripStep[];
};

/**
 * A changed continuation between two steps that both still exist: the
 * outlet it leaves by, the steps it reaches now, and the steps it no longer
 * reaches.
 */
export type Rewire = {
  branch: string | null;
  to: readonly string[];
  from: readonly string[];
};

/** One edit, as the review lists it. */
export type WorkflowEdit = {
  /** Unique among the edits. */
  key: string;
  /** The change marker the step wears: a rewired step reads as modified. */
  kind: WorkflowNodeChange["kind"];
  nodeId: string;
  /** The step's name, from the graph that holds it. */
  title: string;
  /** One line saying what changed, such as "Body changed" or "New step". */
  summary: string;
  strip: EditStrip;
  /** The server's change to the step, null for a step that was only rewired. */
  nodeChange: WorkflowNodeChange | null;
  rewires: readonly Rewire[];
};

/** A change that leaves every run the same. */
export type OrganizationChange = {
  key: string;
  nodeId: string;
  text: string;
};

export type WorkflowEdits = {
  edits: readonly WorkflowEdit[];
  organization: readonly OrganizationChange[];
};

type Side = {
  nodes: ReadonlyMap<string, WorkflowNode>;
  edges: readonly WorkflowEdge[];
  incoming: ReadonlyMap<string, readonly WorkflowEdge[]>;
  outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>;
};

function indexSide(serialized: EditsComparison["baseGraph"]): Side {
  const graph = toWorkflowGraphData(serialized);
  return {
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    edges: graph.edges,
    incoming: Map.groupBy(graph.edges, (edge) => edge.target),
    outgoing: Map.groupBy(graph.edges, (edge) => edge.source),
  };
}

function isGroupFrame(node: WorkflowNode | undefined): boolean {
  return node?.data.type === "group";
}

function title(
  node: WorkflowNode | undefined,
  catalog: ExtensionCatalog
): string {
  return node ? comparisonNodeTitle(node.data, catalog) : "Unavailable step";
}

/** The strip of `nodeId` as one side's graph draws it. */
function stripOn(
  side: Side,
  nodeId: string,
  catalog: ExtensionCatalog,
  order: ReadonlyMap<string, number>
): EditStrip {
  const node = side.nodes.get(nodeId);
  const parent =
    node?.parentId === undefined ? undefined : side.nodes.get(node.parentId);
  const byPathOrder = (left: StripStep, right: StripStep) =>
    (order.get(left.nodeId) ?? 0) - (order.get(right.nodeId) ?? 0);
  return {
    group: isGroupFrame(parent) ? title(parent, catalog) : null,
    before: (side.incoming.get(nodeId) ?? [])
      .map((edge) => {
        const source = side.nodes.get(edge.source);
        return {
          nodeId: edge.source,
          label: title(source, catalog),
          branch: outletName(source, edge.sourceHandle, catalog),
        };
      })
      .toSorted(byPathOrder),
    after: (side.outgoing.get(nodeId) ?? [])
      .map((edge) => ({
        nodeId: edge.target,
        label: title(side.nodes.get(edge.target), catalog),
        branch: outletName(node, edge.sourceHandle, catalog),
      }))
      .toSorted(byPathOrder),
  };
}

/** How an outlet ranks among a node's outlets when the path is read. */
function handleRank(handle: string | null | undefined): number {
  if (handle === LIFECYCLE_STARTED_HANDLE || handle === "true") return 0;
  if (handle === LIFECYCLE_CANCELED_HANDLE || handle === "false") return 2;
  return 1;
}

/**
 * The position of each node in the order a run reaches it, over both graphs
 * together. A node is placed once every connection into it has been read,
 * and the outlets of one node are read True before False and Started before
 * Canceled. Nodes no path reaches follow, top to bottom.
 */
function pathOrder(base: Side, draft: Side): Map<string, number> {
  const nodes = new Map([...base.nodes, ...draft.nodes]);
  const edgeIds = new Set<string>();
  const edges = [...draft.edges, ...base.edges].filter((edge) => {
    const key = `${edge.source}|${edge.sourceHandle ?? ""}|${edge.target}`;
    if (edgeIds.has(key)) return false;
    edgeIds.add(key);
    return nodes.has(edge.source) && nodes.has(edge.target);
  });
  const outgoing = Map.groupBy(edges, (edge) => edge.source);
  const waiting = new Map<string, number>();
  for (const edge of edges) {
    waiting.set(edge.target, (waiting.get(edge.target) ?? 0) + 1);
  }
  const byPosition = [...nodes.values()].toSorted(
    (left, right) =>
      left.position.y - right.position.y || left.position.x - right.position.x
  );
  const roots = byPosition.filter(
    (node) => node.data.type === "lifecycle" || !waiting.has(node.id)
  );
  const order = new Map<string, number>();
  // A stack, so the first outlet's path is read to its end before the next.
  const stack = roots.toReversed().map((node) => node.id);
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (nodeId === undefined || order.has(nodeId)) continue;
    order.set(nodeId, order.size);
    const next = (outgoing.get(nodeId) ?? []).toSorted(
      (left, right) =>
        handleRank(left.sourceHandle) - handleRank(right.sourceHandle)
    );
    const ready: string[] = [];
    for (const edge of next) {
      const remaining = (waiting.get(edge.target) ?? 1) - 1;
      waiting.set(edge.target, remaining);
      if (remaining <= 0) ready.push(edge.target);
    }
    stack.push(...ready.toReversed());
  }
  for (const node of byPosition) {
    if (!order.has(node.id)) order.set(node.id, order.size);
  }
  // A Group frame sits where its first step does.
  for (const node of nodes.values()) {
    const parentId = node.parentId;
    if (parentId === undefined || !isGroupFrame(nodes.get(parentId))) continue;
    const position = order.get(node.id) ?? 0;
    if (position < (order.get(parentId) ?? Number.POSITIVE_INFINITY)) {
      order.set(parentId, position - 0.5);
    }
  }
  return order;
}

/**
 * Whether `side` reaches `target` from the outlet `handle` of `source`
 * passing only through `through`, the steps added or removed on that side.
 */
function reachesThrough(input: {
  side: Side;
  source: string;
  handle: string | null | undefined;
  target: string;
  through: ReadonlySet<string>;
}): boolean {
  const { side, target, through } = input;
  const seen = new Set<string>();
  const frontier = (side.outgoing.get(input.source) ?? [])
    .filter((edge) => (edge.sourceHandle ?? null) === (input.handle ?? null))
    .map((edge) => edge.target);
  while (frontier.length > 0) {
    const nodeId = frontier.pop();
    if (nodeId === undefined || seen.has(nodeId)) continue;
    seen.add(nodeId);
    if (!through.has(nodeId)) continue;
    for (const edge of side.outgoing.get(nodeId) ?? []) {
      if (edge.target === target) return true;
      frontier.push(edge.target);
    }
  }
  return false;
}

/** What a modified step's changed settings come to, in one phrase. */
function settingsSummary(input: {
  catalog: ExtensionCatalog;
  comparison: EditsComparison;
  change: WorkflowNodeChange;
}): string | null {
  const fields = comparisonFields(
    input.catalog,
    input.comparison,
    input.change
  ).filter((field) => field.category === "behavior");
  if (fields.length === 0) return null;
  const [only] = fields;
  if (fields.length === 1 && only?.label === "Enabled") {
    return only.after === false ? "Turned off" : "Turned on";
  }
  const labels = uniq(
    fields.map((field) => (isConditionRulesRow(field) ? "Rules" : field.label))
  );
  return labels.length === 1
    ? `${labels[0]} changed`
    : `${labels.length} settings changed`;
}

function rewirePhrase(rewire: Rewire): string {
  const lead = rewire.branch ? `On ${rewire.branch}, ` : "";
  const phrase =
    rewire.to.length > 0
      ? `now continues to ${rewire.to.join(" and ")}`
      : `no longer continues to ${rewire.from.join(" and ")}`;
  return lead === ""
    ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`
    : `${lead}${phrase}`;
}

/** A name set apart from the sentence around it. */
function quoted(name: string): string {
  return `"${name}"`;
}

/** What a step's move between Groups says, or null when it did not move. */
function membershipText(input: {
  change: WorkflowNodeChange;
  base: Side;
  draft: Side;
  catalog: ExtensionCatalog;
}): string | null {
  const field = input.change.fields.find((item) =>
    isGroupMembershipPath(item.path)
  );
  if (!field) return null;
  const groupName = (side: Side, value: unknown) =>
    typeof value === "string" && isGroupFrame(side.nodes.get(value))
      ? quoted(title(side.nodes.get(value), input.catalog))
      : null;
  const before = groupName(input.base, field.before);
  const after = groupName(input.draft, field.after);
  const step = quoted(
    title(input.draft.nodes.get(input.change.nodeId), input.catalog)
  );
  if (before === null && after !== null) return `${step} moved into ${after}`;
  if (before !== null && after === null)
    return `${step} moved out of ${before}`;
  if (before !== null && after !== null) {
    return `${step} moved from ${before} to ${after}`;
  }
  return `${step} moved between Groups`;
}

/** What one Group frame's own change says. */
function groupText(input: {
  change: WorkflowNodeChange;
  base: Side;
  draft: Side;
  catalog: ExtensionCatalog;
}): string {
  const { change, base, draft, catalog } = input;
  const before = base.nodes.get(change.nodeId);
  const after = draft.nodes.get(change.nodeId);
  if (change.kind === "added")
    return `New Group ${quoted(title(after, catalog))}`;
  if (change.kind === "removed") {
    return `Group ${quoted(title(before, catalog))} removed`;
  }
  const renamed = change.fields.some(
    (field) => field.path[0] === "data" && field.path[1] === "label"
  );
  const described = change.fields.some(
    (field) => field.path[0] === "data" && field.path[1] === "description"
  );
  const name = quoted(title(after, catalog));
  return compact([
    renamed
      ? `Group ${quoted(title(before, catalog))} renamed to ${name}`
      : `Group ${name}`,
    described ? "description changed" : undefined,
    !renamed && !described ? "settings changed" : undefined,
  ]).join(renamed ? ", " : " ");
}

const editsCache = new WeakMap<
  EditsComparison,
  WeakMap<ExtensionCatalog, WorkflowEdits>
>();

/**
 * The edits between the two graphs of `comparison`, in the order a run
 * reaches them, and the changes that leave runs the same. Computed once per
 * comparison and catalog.
 */
export function workflowEdits(
  comparison: EditsComparison,
  catalog: ExtensionCatalog
): WorkflowEdits {
  let byCatalog = editsCache.get(comparison);
  const cached = byCatalog?.get(catalog);
  if (cached) return cached;
  const computed = computeEdits(comparison, catalog);
  if (!byCatalog) {
    byCatalog = new WeakMap();
    editsCache.set(comparison, byCatalog);
  }
  byCatalog.set(catalog, computed);
  return computed;
}

function byOrder(left: { order: number }, right: { order: number }) {
  return left.order - right.order;
}

function computeEdits(
  comparison: EditsComparison,
  catalog: ExtensionCatalog
): WorkflowEdits {
  const base = indexSide(comparison.baseGraph);
  const draft = indexSide(comparison.draftGraph);
  const order = pathOrder(base, draft);
  const at = (nodeId: string) => order.get(nodeId) ?? Number.MAX_SAFE_INTEGER;

  const groupFrame = (nodeId: string) =>
    isGroupFrameChange({
      before: base.nodes.get(nodeId)?.data.type,
      after: draft.nodes.get(nodeId)?.data.type,
    });
  const stepChanges = comparison.nodeChanges.filter(
    (change) => !groupFrame(change.nodeId)
  );
  const added = new Set(
    stepChanges
      .filter((change) => change.kind === "added")
      .map((change) => change.nodeId)
  );
  const removed = new Set(
    stepChanges
      .filter((change) => change.kind === "removed")
      .map((change) => change.nodeId)
  );

  // Connections between two steps that both still exist, and that no added
  // or removed step explains, by the outlet they leave.
  const draftEdges = new Map(draft.edges.map((edge) => [edge.id, edge]));
  const baseEdges = new Map(base.edges.map((edge) => [edge.id, edge]));
  const rewired = new Map<
    string,
    { source: string; handle: string | null; to: string[]; from: string[] }
  >();
  for (const change of comparison.edgeChanges) {
    const edge = (change.kind === "added" ? draftEdges : baseEdges).get(
      change.edgeId
    );
    if (!edge) continue;
    if (
      added.has(edge.source) ||
      added.has(edge.target) ||
      removed.has(edge.source) ||
      removed.has(edge.target)
    ) {
      continue;
    }
    // A connection replaced by a step put in or taken out of its path.
    const explained = reachesThrough({
      side: change.kind === "added" ? base : draft,
      source: edge.source,
      handle: edge.sourceHandle,
      target: edge.target,
      through: change.kind === "added" ? removed : added,
    });
    if (explained) continue;
    const handle = edge.sourceHandle ?? null;
    const key = `${edge.source}|${handle ?? ""}`;
    const entry = rewired.get(key) ?? {
      source: edge.source,
      handle,
      to: [],
      from: [],
    };
    const side = change.kind === "added" ? draft : base;
    (change.kind === "added" ? entry.to : entry.from).push(
      title(side.nodes.get(edge.target), catalog)
    );
    rewired.set(key, entry);
  }
  const rewiresBySource = Map.groupBy(
    rewired.values(),
    (entry) => entry.source
  );

  const organization: Array<OrganizationChange & { order: number }> = [];
  const edits: Array<WorkflowEdit & { order: number }> = [];

  for (const change of comparison.nodeChanges) {
    if (groupFrame(change.nodeId)) {
      organization.push({
        key: `group:${change.nodeId}`,
        nodeId: change.nodeId,
        text: groupText({ change, base, draft, catalog }),
        order: at(change.nodeId),
      });
      continue;
    }
    const side = change.kind === "removed" ? base : draft;
    const sourceRewires = (rewiresBySource.get(change.nodeId) ?? []).map(
      (entry): Rewire => ({
        branch: outletName(
          draft.nodes.get(entry.source),
          entry.handle,
          catalog
        ),
        to: entry.to,
        from: entry.from,
      })
    );
    rewiresBySource.delete(change.nodeId);
    const moved =
      change.kind === "modified"
        ? membershipText({ change, base, draft, catalog })
        : null;
    if (moved !== null) {
      organization.push({
        key: `membership:${change.nodeId}`,
        nodeId: change.nodeId,
        text: moved,
        order: at(change.nodeId),
      });
    }
    const settings =
      change.kind === "modified"
        ? settingsSummary({ catalog, comparison, change })
        : null;
    const ownSummary =
      change.kind === "added"
        ? // The start of a run is no step, so a new one is said to be added.
          draft.nodes.get(change.nodeId)?.data.type === "lifecycle"
          ? "Added"
          : "New step"
        : change.kind === "removed"
          ? "Removed"
          : settings;
    // A step whose only change is its Group leaves runs the same.
    if (ownSummary === null && sourceRewires.length === 0) {
      if (moved === null) {
        // A modification the editor cannot name still changes the step.
        edits.push({
          key: `node:${change.nodeId}`,
          kind: "modified",
          nodeId: change.nodeId,
          title: title(side.nodes.get(change.nodeId), catalog),
          summary: "Settings changed",
          strip: stripOn(side, change.nodeId, catalog, order),
          nodeChange: change,
          rewires: [],
          order: at(change.nodeId),
        });
      }
      continue;
    }
    edits.push({
      key: `node:${change.nodeId}`,
      kind: change.kind,
      nodeId: change.nodeId,
      title: title(side.nodes.get(change.nodeId), catalog),
      summary: compact([ownSummary, ...sourceRewires.map(rewirePhrase)]).join(
        " · "
      ),
      strip: stripOn(side, change.nodeId, catalog, order),
      nodeChange: change,
      rewires: sourceRewires,
      order: at(change.nodeId),
    });
  }

  for (const [source, entries] of rewiresBySource) {
    const rewires = entries.map((entry): Rewire => ({
      branch: outletName(draft.nodes.get(source), entry.handle, catalog),
      to: entry.to,
      from: entry.from,
    }));
    edits.push({
      key: `rewire:${source}`,
      kind: "modified",
      nodeId: source,
      title: title(draft.nodes.get(source), catalog),
      summary: rewires.map(rewirePhrase).join(" · "),
      strip: stripOn(draft, source, catalog, order),
      nodeChange: null,
      rewires,
      order: at(source),
    });
  }

  return {
    edits: edits.toSorted(byOrder).map(({ order: _order, ...edit }) => edit),
    organization: organization
      .toSorted(byOrder)
      .map(({ order: _order, ...item }) => item),
  };
}

/**
 * The review's one-line count: how many edits change what runs and how many
 * changes do not.
 */
export function editsCountLine(edits: WorkflowEdits): string {
  const changing = edits.edits.length;
  const other = edits.organization.length;
  const first =
    changing === 0
      ? "No edit changes what runs."
      : changing === 1
        ? "1 edit changes what runs."
        : `${changing} edits change what runs.`;
  if (other === 0) return first;
  return `${first} ${other} ${other === 1 ? "does" : "do"} not.`;
}

const editsByNode = new WeakMap<
  WorkflowEdits,
  ReadonlyMap<string, WorkflowEdit>
>();

/** The edit of the step `nodeId`, or undefined when the step has none. */
export function editOfNode(
  edits: WorkflowEdits,
  nodeId: string
): WorkflowEdit | undefined {
  let byNode = editsByNode.get(edits);
  if (!byNode) {
    byNode = new Map(edits.edits.map((edit) => [edit.nodeId, edit]));
    editsByNode.set(edits, byNode);
  }
  return byNode.get(nodeId);
}
