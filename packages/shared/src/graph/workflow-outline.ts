/**
 * A workflow as an outline: one row per step in the order a run reaches it,
 * with the outlets of a Condition, an Event Split and the Lifecycle Node as
 * labelled blocks, side-by-side arms under "At the same time", and a Group as a
 * section holding its members. Every step appears once. Any other place that
 * reaches it carries a "Continues at step N" row. Step numbers follow the rows,
 * so the editor's outline and its canvas cards share them.
 */

import { getStartSummary } from "#src/graph/node-display";
import { compact, sortBy, uniq } from "es-toolkit/array";
import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";
import {
  getConditionBranchDisplayLabel,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import {
  type ExtensionCatalog,
  findAction,
  findEvent,
} from "#src/extensions/catalog";
import { eventsReaching } from "#src/graph/events-reaching";
import { isGroupNode } from "#src/graph/group-boundary";
import { actionTypeOf, isLifecycleNode } from "#src/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  conditionRulesPhrase,
  eventLabel,
  overlappingRunsSentence,
  startClauses,
  stepLabel,
  stopClauses,
  waitTiming,
} from "#src/graph/workflow-summary";
import {
  eventSplitOutlet,
  eventSplitOutletEvent,
} from "#src/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";
import {
  manualStartAllowed,
  readLifecycleRules,
} from "#src/lifecycle/lifecycle-rules";
import { isBlank } from "#src/types/string";

/** What a step does, which picks its glyph. */
export type OutlineStepKind = "action" | "condition" | "wait" | "event-split";

type RowBase = {
  /** Unique across the whole outline. */
  key: string;
  /** How far the row is indented. Rows under an outlet sit one deeper than the step that opens it. */
  depth: number;
  /** The key of the row this row sits under, or null at the top of its section. */
  parentKey: string | null;
};

/** The Lifecycle Node, as what starts a run. */
export type OutlineLifecycleRow = RowBase & {
  kind: "lifecycle";
  nodeId: string;
  /**
   * The builder's name for the start, such as "Appointment booked", else what
   * starts it, such as "Appointment created". The canvas card titles the start
   * the same way.
   */
  label: string;
  /**
   * Beneath a named start, what starts it as its card says it, such as "On
   * Appointment created"; beneath an unnamed one, the Start Filter in words.
   * Null when there is nothing to add.
   */
  summary: string | null;
  /**
   * What a newer start does to a run in progress, or null when every arrival
   * starts a run of its own.
   */
  overlap: string | null;
};

export type OutlineStepRow = RowBase & {
  kind: "step";
  nodeId: string;
  /** The step's number in run order, or null for a step `numberOf` leaves out. */
  number: number | null;
  stepKind: OutlineStepKind;
  /** The action id, which picks an integration's icon. Undefined when none is chosen. */
  actionType: string | undefined;
  label: string;
  /** One line saying what the step does, or null when the label says it all. */
  summary: string | null;
  disabled: boolean;
};

export type OutlineGroupRow = RowBase & {
  kind: "group";
  nodeId: string;
  label: string;
  summary: string;
  /** How many step rows the Group holds. */
  stepCount: number;
};

/**
 * One outlet of a Condition, an Event Split or the Lifecycle Node, as the label
 * over the rows behind it.
 */
export type OutlineOutletRow = RowBase & {
  kind: "outlet";
  sourceNodeId: string;
  handle: string;
  /** The outlet's name on the canvas: "True", "False", an Event's label, or "Canceled". */
  outletName: string;
  /** The label in reading form: "If true", "Otherwise", "When Payment settled". */
  label: string;
  /** What the row says: the label, with ", the path ends" when nothing is behind the outlet. */
  text: string;
  /** A Cancel Filter in words, or null. */
  detail: string | null;
  /** Whether nothing is connected behind the outlet. */
  ends: boolean;
  /** How many step rows sit behind the outlet. */
  stepCount: number;
};

/** The label over one of several arms that run at the same time. */
export type OutlineParallelRow = RowBase & {
  kind: "parallel";
  /** "At the same time" over the first arm, "and" over each arm after it. */
  text: string;
  /** How many step rows the arm holds. */
  stepCount: number;
};

/** A place that reaches a step listed elsewhere in the outline. */
export type OutlineContinuesRow = RowBase & {
  kind: "continues";
  targetNodeId: string;
  /** "Continues at step 12", or the Group's or step's name when it has no number. */
  text: string;
};

export type OutlineRow =
  | OutlineLifecycleRow
  | OutlineStepRow
  | OutlineGroupRow
  | OutlineOutletRow
  | OutlineParallelRow
  | OutlineContinuesRow;

export type WorkflowOutline = {
  /** The Lifecycle Node's row, or empty for a graph without one. */
  starts: readonly OutlineRow[];
  /** What follows the Started outlet. */
  steps: readonly OutlineRow[];
  /** The Canceled outlet and what follows it. Empty when it has neither Cancel Events nor steps. */
  stops: readonly OutlineRow[];
  /** Steps no path from the Lifecycle Node reaches. */
  unconnected: readonly OutlineRow[];
};

export type WorkflowOutlineInput = {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
  /**
   * The numbers to show, by node id, in place of the ones this graph's run order
   * gives. The review sheet's graph holds removed steps, and it shows the draft's
   * numbers so a row and its card agree.
   */
  numberOf?: ReadonlyMap<string, number> | undefined;
};

/**
 * The outline of the workflow made of `nodes` and `edges`, in run order: the
 * Started path, then the Canceled path, then any step no path reaches.
 */
export function workflowOutline(input: WorkflowOutlineInput): WorkflowOutline {
  const walker = indexWalker(input);
  const lifecycle = input.nodes.find(isLifecycleNode);
  const started = lifecycle
    ? follow(
        walker,
        walker.outer,
        lifecycleTargets(walker, lifecycle.id, LIFECYCLE_STARTED_HANDLE)
      )
    : [];
  const canceled = lifecycle
    ? follow(
        walker,
        walker.outer,
        lifecycleTargets(walker, lifecycle.id, LIFECYCLE_CANCELED_HANDLE)
      )
    : [];
  const unconnected = unreachedUnits(walker).flatMap((unit) =>
    walker.visited.has(unit) ? [] : follow(walker, walker.outer, [unit])
  );

  const rows = new RowWriter(walker, input.numberOf);
  const starts = lifecycle ? [rows.lifecycle(lifecycle)] : [];
  const steps = rows.flatten(started, 0, null);
  const stops = lifecycle ? rows.stops(lifecycle, canceled) : [];
  const unconnectedRows = rows.flatten(unconnected, 0, null);
  return rows.finish({
    starts,
    steps,
    stops,
    unconnected: unconnectedRows,
  });
}

/**
 * Each step's number in run order, by node id: the numbers the outline rows
 * show, which a canvas card shows too. A Group frame, the Lifecycle Node and an
 * Add node have none.
 */
export function workflowStepNumbers(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): ReadonlyMap<string, number> {
  return stepNumbersOf(workflowOutline(input));
}

/** The numbers an outline's step rows carry, by node id. */
export function stepNumbersOf(
  outline: WorkflowOutline
): ReadonlyMap<string, number> {
  return new Map(
    outlineRows(outline).flatMap((row) =>
      row.kind === "step" && row.number !== null
        ? [[row.nodeId, row.number] as const]
        : []
    )
  );
}

/** Every row of an outline, section after section. */
export function outlineRows(outline: WorkflowOutline): readonly OutlineRow[] {
  return [
    ...outline.starts,
    ...outline.steps,
    ...outline.stops,
    ...outline.unconnected,
  ];
}

/**
 * The name of the outlet `handle` of `source`, as the canvas labels it: "True"
 * or "False" for a Condition, "Started" or "Canceled" for the Lifecycle Node,
 * and the Event's label for an Event Split. Null for a step's one outlet.
 */
export function outletName(
  source: WorkflowNode | undefined,
  handle: string | null | undefined,
  catalog: ExtensionCatalog
): string | null {
  if (handle === null || handle === undefined) return null;
  const condition = getConditionBranchDisplayLabel(handle);
  if (condition !== null) return condition;
  if (isLifecycleNode(source)) {
    if (handle === LIFECYCLE_STARTED_HANDLE) return "Started";
    if (handle === LIFECYCLE_CANCELED_HANDLE) return "Canceled";
  }
  const eventName = eventSplitOutletEvent(handle);
  if (eventName !== null) {
    return findEvent(catalog, eventName)?.label ?? eventName;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Walking the graph into a tree of items.

/**
 * What the walk builds. A unit is a node id, or on the workflow's top level a
 * Group's id for every member of that Group.
 */
type Item =
  | { kind: "step"; nodeId: string }
  | { kind: "group"; nodeId: string; body: Item[] }
  | { kind: "branch"; nodeId: string; outlets: Outlet[] }
  | { kind: "parallel"; arms: Item[][] }
  | { kind: "continues"; unit: string };

type Outlet = {
  handle: string;
  label: string;
  body: Item[];
};

/**
 * Where a walk runs: the workflow's top level, or the inside of one Group.
 * `unitOf` answers undefined for a node outside the scope.
 */
type Scope = {
  unitOf: (nodeId: string) => string | undefined;
  /** Units entered from more than one place in the scope, where arms meet. */
  joins: ReadonlySet<string>;
  /** Whether edges leaving the scope lead on to the top level, as they do from a Group. */
  inner: boolean;
};

type Walker = {
  catalog: ExtensionCatalog;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  nodesById: ReadonlyMap<string, WorkflowNode>;
  edgesBySource: ReadonlyMap<string, WorkflowEdge[]>;
  edgesByTarget: ReadonlyMap<string, WorkflowEdge[]>;
  membersByGroup: ReadonlyMap<string, WorkflowNode[]>;
  outer: Scope;
  /** Units already written, so no unit is written twice. */
  visited: Set<string>;
};

function indexWalker(input: WorkflowOutlineInput): Walker {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const outerUnitOf = (nodeId: string): string | undefined => {
    const node = nodesById.get(nodeId);
    if (!node || node.data.type === "add") return undefined;
    const parentId = node.parentId;
    return parentId !== undefined && isGroupNode(nodesById.get(parentId))
      ? parentId
      : nodeId;
  };
  return {
    catalog: input.catalog,
    nodes: input.nodes,
    edges: input.edges,
    nodesById,
    // Maps, because node ids are text the builder chose.
    edgesBySource: Map.groupBy(input.edges, (edge) => edge.source),
    edgesByTarget: Map.groupBy(input.edges, (edge) => edge.target),
    membersByGroup: Map.groupBy(
      input.nodes.filter(
        (node) =>
          node.parentId !== undefined &&
          isGroupNode(nodesById.get(node.parentId)) &&
          node.data.type !== "add"
      ),
      (node) => node.parentId ?? ""
    ),
    outer: {
      unitOf: outerUnitOf,
      joins: joinsOf(input.edges, outerUnitOf, outerUnitOf),
      inner: false,
    },
    visited: new Set(),
  };
}

/**
 * The units entered from more than one distinct unit. `sourceUnitOf` names the
 * unit an edge leaves from, which inside a Group is one shared name for every
 * node outside it.
 */
function joinsOf(
  edges: readonly WorkflowEdge[],
  targetUnitOf: (nodeId: string) => string | undefined,
  sourceUnitOf: (nodeId: string) => string | undefined
): Set<string> {
  const sourcesByUnit = new Map<string, Set<string>>();
  for (const edge of edges) {
    const target = targetUnitOf(edge.target);
    const source = sourceUnitOf(edge.source);
    if (target === undefined || source === undefined || source === target) {
      continue;
    }
    const sources = sourcesByUnit.get(target) ?? new Set();
    sources.add(source);
    sourcesByUnit.set(target, sources);
  }
  return new Set(
    [...sourcesByUnit].flatMap(([unit, sources]) =>
      sources.size > 1 ? [unit] : []
    )
  );
}

function lifecycleTargets(
  walker: Walker,
  lifecycleId: string,
  handle: string
): string[] {
  return edgeTargets(
    walker,
    walker.outer,
    lifecycleId,
    (edge) => edge.sourceHandle === handle
  ).inside;
}

/**
 * The units the edges leaving `nodeId` that `keep` accepts reach: `inside` the
 * scope, and on the top level for the edges that leave a Group.
 */
function edgeTargets(
  walker: Walker,
  scope: Scope,
  nodeId: string,
  keep: (edge: WorkflowEdge) => boolean = () => true
): { inside: string[]; outside: string[] } {
  const own = scope.unitOf(nodeId);
  const edges = (walker.edgesBySource.get(nodeId) ?? []).filter(keep);
  const inside = uniq(
    compact(edges.map((edge) => scope.unitOf(edge.target)))
  ).filter((unit) => unit !== own);
  const outside = scope.inner
    ? uniq(
        compact(
          edges
            .filter((edge) => scope.unitOf(edge.target) === undefined)
            .map((edge) => walker.outer.unitOf(edge.target))
        )
      )
    : [];
  return { inside, outside };
}

/** A walk's items, and the joins it stopped at that something else must write. */
type Walked = { items: Item[]; stops: string[] };

/**
 * The items a run passes through from `units`, then from every join those
 * items stopped at, until nothing is left to write.
 */
function follow(
  walker: Walker,
  scope: Scope,
  units: readonly string[]
): Item[] {
  const first = walk(walker, scope, units, undefined);
  const items = [...first.items];
  let pending = first.stops;
  for (;;) {
    const join = pending.find((unit) => !walker.visited.has(unit));
    if (join === undefined) {
      return items;
    }
    const next = walk(walker, scope, [join], join);
    items.push(...next.items);
    pending = [...pending.filter((unit) => unit !== join), ...next.stops];
  }
}

/**
 * The items from `units`. Several units are arms that run at the same time. A
 * walk stops at a join it was not told to enter, and hands it back, so the
 * item that opened the arms carries on from it. A unit already written becomes
 * a reference to it.
 */
function walk(
  walker: Walker,
  scope: Scope,
  units: readonly string[],
  enteringJoin: string | undefined
): Walked {
  const items: Item[] = [];
  const stops: string[] = [];
  let frontier = units;
  let allowedJoin = enteringJoin;
  for (;;) {
    if (frontier.length > 1) {
      const arms = sortUnits(walker, frontier).map((unit) =>
        walk(walker, scope, [unit], undefined)
      );
      const settled = settle(walker, arms);
      items.push({ kind: "parallel", arms: settled.bodies });
      stops.push(...settled.stops);
      if (settled.join === undefined) {
        return { items, stops };
      }
      frontier = [settled.join];
      allowedJoin = settled.join;
      continue;
    }
    const [unit] = frontier;
    if (unit === undefined) {
      return { items, stops };
    }
    if (walker.visited.has(unit)) {
      items.push({ kind: "continues", unit });
      return { items, stops };
    }
    if (scope.joins.has(unit) && unit !== allowedJoin) {
      stops.push(unit);
      return { items, stops };
    }
    allowedJoin = undefined;
    walker.visited.add(unit);
    const described = describeUnit(walker, scope, unit);
    if (described === undefined) {
      return { items, stops };
    }
    items.push(described.item);
    stops.push(...described.stops);
    frontier = described.next;
    if (described.join !== undefined) {
      allowedJoin = described.join;
    }
  }
}

/**
 * Where several walked bodies go on together. The first join any of them
 * stopped at that nothing has written is where the opener carries on. A body
 * that stopped at another join, or that is empty because it leads straight to
 * the join, ends with a reference row.
 */
function settle(
  walker: Walker,
  walked: readonly Walked[]
): { bodies: Item[][]; join: string | undefined; stops: string[] } {
  const join = walked
    .flatMap((body) => body.stops)
    .find((unit) => !walker.visited.has(unit));
  const bodies = walked.map((body) => {
    const elsewhere = body.stops.filter((unit) => unit !== join);
    const leadsToJoin =
      body.items.length === 0 &&
      join !== undefined &&
      body.stops.includes(join);
    return [
      ...body.items,
      ...uniq([...elsewhere, ...(leadsToJoin ? [join] : [])]).map(
        (unit): Item => ({ kind: "continues", unit })
      ),
    ];
  });
  const stops = uniq(
    walked
      .flatMap((body) => body.stops)
      .filter((unit) => unit !== join && !walker.visited.has(unit))
  );
  return { bodies, join, stops };
}

type Described = {
  item: Item;
  /** The units the walk goes on to. */
  next: string[];
  /** A join the walk may enter next, where the item's own branches meet. */
  join?: string | undefined;
  stops: string[];
};

function describeUnit(
  walker: Walker,
  scope: Scope,
  unit: string
): Described | undefined {
  const node = walker.nodesById.get(unit);
  if (!node || isLifecycleNode(node)) {
    return undefined;
  }
  if (isGroupNode(node)) {
    return describeGroup(walker, node);
  }
  const actionType = actionTypeOf(node);
  if (actionType === BUILT_IN_ACTION_IDS.condition) {
    return describeBranches(
      walker,
      scope,
      node,
      (["true", "false"] as const).map((branch) => ({
        handle: branch,
        label: branch === "true" ? "If true" : "Otherwise",
        keep: (edge: WorkflowEdge) =>
          normalizeConditionBranch(edge.sourceHandle) === branch,
      }))
    );
  }
  if (actionType === BUILT_IN_ACTION_IDS.eventSplit) {
    return describeBranches(
      walker,
      scope,
      node,
      splitEvents(walker, node).map((eventName) => ({
        handle: eventSplitOutlet(eventName),
        label: `When ${eventLabel(walker.catalog, eventName)}`,
        keep: (edge: WorkflowEdge) =>
          eventSplitOutletEvent(edge.sourceHandle) === eventName,
      }))
    );
  }
  return {
    item: { kind: "step", nodeId: unit },
    next: edgeTargets(walker, scope, unit).inside,
    stops: [],
  };
}

/**
 * The Events an Event Split has outlets for: each Event that can reach it, then
 * any Event a connection still names that no longer does.
 */
function splitEvents(walker: Walker, node: WorkflowNode): string[] {
  const reaching = eventsReaching({
    targetNodeId: node.id,
    nodes: walker.nodes,
    edges: walker.edges,
    catalog: walker.catalog,
  }).map((event) => event.name);
  const connected = compact(
    (walker.edgesBySource.get(node.id) ?? []).map((edge) =>
      eventSplitOutletEvent(edge.sourceHandle)
    )
  );
  return uniq([...reaching, ...connected]);
}

/**
 * A Condition or an Event Split: each outlet's rows, and the join they meet at,
 * where the walk carries on. An outlet whose connections leave the Group it
 * sits in reads as a reference to the step they reach.
 */
function describeBranches(
  walker: Walker,
  scope: Scope,
  node: WorkflowNode,
  outlets: readonly {
    handle: string;
    label: string;
    keep: (edge: WorkflowEdge) => boolean;
  }[]
): Described {
  const walked = outlets.map((outlet): Walked => {
    const targets = edgeTargets(walker, scope, node.id, outlet.keep);
    if (targets.inside.length > 0) {
      return walk(walker, scope, targets.inside, undefined);
    }
    return {
      items: targets.outside.map((unit): Item => ({ kind: "continues", unit })),
      stops: [],
    };
  });
  const settled = settle(walker, walked);
  return {
    item: {
      kind: "branch",
      nodeId: node.id,
      outlets: outlets.map((outlet, index) => ({
        handle: outlet.handle,
        label: outlet.label,
        body: settled.bodies[index] ?? [],
      })),
    },
    next: settled.join === undefined ? [] : [settled.join],
    join: settled.join,
    stops: settled.stops,
  };
}

/**
 * A Group as a section: its members walked from the ones its entering
 * connections reach, then any member no path inside reaches. The walk carries
 * on at the steps its leaving connections reach.
 */
function describeGroup(walker: Walker, group: WorkflowNode): Described {
  const members = walker.membersByGroup.get(group.id) ?? [];
  const memberIds = new Set(members.map((member) => member.id));
  const unitOf = (nodeId: string) =>
    memberIds.has(nodeId) ? nodeId : undefined;
  const scope: Scope = {
    unitOf,
    // Every node outside the Group counts as one place a member is entered from.
    joins: joinsOf(walker.edges, unitOf, (nodeId) =>
      memberIds.has(nodeId) ? nodeId : group.id
    ),
    inner: true,
  };
  const entered = (member: WorkflowNode) =>
    (walker.edgesByTarget.get(member.id) ?? []).some(
      (edge) => !memberIds.has(edge.source)
    );
  const entries = members.filter(entered).map((member) => member.id);
  const body = follow(walker, scope, sortUnits(walker, entries));
  for (const memberId of sortUnits(
    walker,
    members.map((member) => member.id)
  )) {
    if (!walker.visited.has(memberId)) {
      body.push(...follow(walker, scope, [memberId]));
    }
  }
  const next = uniq(
    members.flatMap((member) => edgeTargets(walker, scope, member.id).outside)
  ).filter((unit) => unit !== group.id);
  return { item: { kind: "group", nodeId: group.id, body }, next, stops: [] };
}

/**
 * Units in the order the canvas reads them, left to right and then top to
 * bottom, so the arms of a fan-out list the way their cards sit.
 */
function sortUnits(walker: Walker, units: readonly string[]): string[] {
  const placed = units.map((unit) => ({
    unit,
    ...(walker.nodesById.get(unit)?.position ?? { x: 0, y: 0 }),
  }));
  return sortBy(placed, ["x", "y"]).map((entry) => entry.unit);
}

/**
 * The top-level units no path from the Lifecycle Node reached, those nothing
 * enters first, each in canvas order.
 */
function unreachedUnits(walker: Walker): string[] {
  const units = uniq(
    compact(
      walker.nodes
        .filter((node) => !isLifecycleNode(node))
        .map((node) => walker.outer.unitOf(node.id))
    )
  ).filter((unit) => !walker.visited.has(unit));
  const entered = (unit: string) =>
    walker.edges.some(
      (edge) =>
        walker.outer.unitOf(edge.target) === unit &&
        walker.outer.unitOf(edge.source) !== unit
    );
  const placed = units.map((unit) => ({
    unit,
    entered: entered(unit) ? 1 : 0,
    ...(walker.nodesById.get(unit)?.position ?? { x: 0, y: 0 }),
  }));
  return sortBy(placed, ["entered", "y", "x"]).map((entry) => entry.unit);
}

// ---------------------------------------------------------------------------
// Writing items as rows.

/** Writes rows in order, numbering step rows as it goes. */
class RowWriter {
  private number = 0;
  private synthetic = 0;

  constructor(
    private readonly walker: Walker,
    private readonly numberOf: ReadonlyMap<string, number> | undefined
  ) {}

  lifecycle(node: WorkflowNode): OutlineLifecycleRow {
    const rules = readLifecycleRules(node.data.config);
    const clauses = startClauses(rules, this.walker.catalog);
    const label =
      clauses.length > 0
        ? clauses.map((clause) => clause.subject).join(" or ")
        : manualStartAllowed(rules)
          ? "Someone runs it by hand"
          : "Nothing starts it yet";
    const name = node.data.label?.trim();
    return {
      kind: "lifecycle",
      key: node.id,
      depth: 0,
      parentKey: null,
      nodeId: node.id,
      label: name || label,
      summary: name
        ? getStartSummary(node.data.config, this.walker.catalog)
        : joinOrNull(compact(clauses.map((clause) => clause.condition))),
      overlap: overlappingRunsSentence(rules, this.walker.catalog),
    };
  }

  /** The Canceled outlet under "Stops when", with its rows at the top level. */
  stops(node: WorkflowNode, canceled: readonly Item[]): OutlineRow[] {
    const rules = readLifecycleRules(node.data.config);
    const clauses = stopClauses(rules, this.walker.catalog);
    if (clauses.length === 0 && canceled.length === 0) {
      return [];
    }
    const label =
      clauses.length > 0
        ? clauses.map((clause) => clause.subject).join(" or ")
        : "Canceled, with no Cancel Event set";
    const key = `outlet:${node.id}:${LIFECYCLE_CANCELED_HANDLE}`;
    const outlet: OutlineOutletRow = {
      kind: "outlet",
      key,
      depth: 0,
      parentKey: null,
      sourceNodeId: node.id,
      handle: LIFECYCLE_CANCELED_HANDLE,
      outletName: "Canceled",
      label,
      // A stop needs no steps behind it, so an empty outlet says nothing more.
      text: label,
      detail: joinOrNull(compact(clauses.map((clause) => clause.condition))),
      ends: canceled.length === 0,
      stepCount: 0,
    };
    return [outlet, ...this.flatten(canceled, 0, key)];
  }

  flatten(
    items: readonly Item[],
    depth: number,
    parentKey: string | null
  ): OutlineRow[] {
    const rows: OutlineRow[] = [];
    // The step a fan-out leaves from, which its arms sit under.
    let anchor = parentKey;
    for (const item of items) {
      switch (item.kind) {
        case "step":
          rows.push(this.stepRow(item.nodeId, depth, parentKey));
          anchor = item.nodeId;
          break;
        case "group":
          rows.push(this.groupRow(item.nodeId, depth, parentKey));
          rows.push(...this.flatten(item.body, depth + 1, item.nodeId));
          anchor = item.nodeId;
          break;
        case "branch":
          rows.push(this.stepRow(item.nodeId, depth, parentKey));
          for (const outlet of item.outlets) {
            rows.push(...this.outletRows(item.nodeId, outlet, depth + 1));
          }
          anchor = item.nodeId;
          break;
        case "parallel":
          for (const [index, arm] of item.arms.entries()) {
            const key = `arm:${anchor ?? "top"}:${(this.synthetic += 1)}`;
            rows.push({
              kind: "parallel",
              key,
              depth: depth + 1,
              parentKey: anchor,
              text: index === 0 ? "At the same time" : "and",
              stepCount: 0,
            });
            rows.push(...this.flatten(arm, depth + 1, key));
          }
          break;
        default:
          rows.push({
            kind: "continues",
            key: `continues:${(this.synthetic += 1)}`,
            depth,
            parentKey,
            targetNodeId: item.unit,
            text: "",
          });
      }
    }
    return rows;
  }

  private outletRows(
    sourceNodeId: string,
    outlet: Outlet,
    depth: number
  ): OutlineRow[] {
    const key = `outlet:${sourceNodeId}:${outlet.handle}`;
    const ends = outlet.body.length === 0;
    const row: OutlineOutletRow = {
      kind: "outlet",
      key,
      depth,
      parentKey: sourceNodeId,
      sourceNodeId,
      handle: outlet.handle,
      outletName:
        outletName(
          this.walker.nodesById.get(sourceNodeId),
          outlet.handle,
          this.walker.catalog
        ) ?? outlet.label,
      label: outlet.label,
      text: ends ? `${outlet.label}, the path ends` : outlet.label,
      detail: null,
      ends,
      stepCount: 0,
    };
    return [row, ...this.flatten(outlet.body, depth, key)];
  }

  private stepRow(
    nodeId: string,
    depth: number,
    parentKey: string | null
  ): OutlineStepRow {
    const node = this.walker.nodesById.get(nodeId);
    this.number += 1;
    const number = this.numberOf
      ? (this.numberOf.get(nodeId) ?? null)
      : this.number;
    if (!node) {
      return {
        kind: "step",
        key: nodeId,
        depth,
        parentKey,
        nodeId,
        number,
        stepKind: "action",
        actionType: undefined,
        label: nodeId,
        summary: null,
        disabled: false,
      };
    }
    const actionType = actionTypeOf(node);
    const stepKind: OutlineStepKind =
      actionType === BUILT_IN_ACTION_IDS.condition
        ? "condition"
        : actionType === BUILT_IN_ACTION_IDS.wait
          ? "wait"
          : actionType === BUILT_IN_ACTION_IDS.eventSplit
            ? "event-split"
            : "action";
    const label = capitalize(stepLabel(this.walker.catalog, node));
    return {
      kind: "step",
      key: nodeId,
      depth,
      parentKey,
      nodeId,
      number,
      stepKind,
      actionType,
      label: stepKind === "condition" ? `If ${label}` : label,
      summary: this.stepSummary(node, stepKind, actionType, label),
      disabled: node.data.enabled === false,
    };
  }

  /**
   * One line saying what a step does: the builder's own description where it
   * says something, and otherwise the words the workflow summary uses.
   */
  private stepSummary(
    node: WorkflowNode,
    stepKind: OutlineStepKind,
    actionType: string | undefined,
    label: string
  ): string | null {
    const description = node.data.description?.trim() || undefined;
    switch (stepKind) {
      case "condition":
        return joinOrNull(
          compact([conditionRulesPhrase(node.data.config), description])
        );
      case "wait": {
        const timing = waitTiming(this.walker, node);
        return timing ? `Waits ${timing}` : (description ?? null);
      }
      case "event-split":
        return description ?? "Picks a path by the Event that arrived";
      default: {
        if (description) return description;
        if (actionType === undefined || isBlank(actionType)) {
          return isBlank(node.data.label) ? null : "No action chosen";
        }
        const actionLabel = findAction(this.walker.catalog, actionType)?.label;
        if (actionLabel === undefined) {
          return isBlank(node.data.label)
            ? null
            : "An action this app does not offer";
        }
        return actionLabel === label ? null : actionLabel;
      }
    }
  }

  private groupRow(
    nodeId: string,
    depth: number,
    parentKey: string | null
  ): OutlineGroupRow {
    const node = this.walker.nodesById.get(nodeId);
    return {
      kind: "group",
      key: nodeId,
      depth,
      parentKey,
      nodeId,
      label: node ? stepLabel(this.walker.catalog, node) : nodeId,
      summary: node?.data.description?.trim() || "",
      stepCount: 0,
    };
  }

  /**
   * The outline with each label's step count and each reference's words, which
   * both need every row written first.
   */
  finish(outline: WorkflowOutline): WorkflowOutline {
    const all = outlineRows(outline);
    const parentOf = new Map(all.map((row) => [row.key, row.parentKey]));
    const counts = new Map<string, number>();
    for (const row of all) {
      if (row.kind !== "step") continue;
      let parentKey = row.parentKey;
      while (parentKey !== null) {
        counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1);
        parentKey = parentOf.get(parentKey) ?? null;
      }
    }
    const numbers = stepNumbersOf(outline);
    const nameOf = new Map(
      all.flatMap((row) =>
        row.kind === "step" || row.kind === "group"
          ? [[row.nodeId, row.label] as const]
          : []
      )
    );
    const finishRow = (row: OutlineRow): OutlineRow => {
      switch (row.kind) {
        case "group": {
          const count = counts.get(row.key) ?? 0;
          return {
            ...row,
            stepCount: count,
            summary: row.summary || stepsNoun(count),
          };
        }
        case "outlet":
        case "parallel":
          return { ...row, stepCount: counts.get(row.key) ?? 0 };
        case "continues": {
          const number = numbers.get(row.targetNodeId);
          return {
            ...row,
            text:
              number === undefined
                ? `Continues at ${nameOf.get(row.targetNodeId) ?? "a step listed elsewhere"}`
                : `Continues at step ${number}`,
          };
        }
        default:
          return row;
      }
    };
    return {
      starts: outline.starts.map(finishRow),
      steps: outline.steps.map(finishRow),
      stops: outline.stops.map(finishRow),
      unconnected: outline.unconnected.map(finishRow),
    };
  }
}

function joinOrNull(parts: readonly string[]): string | null {
  return parts.length === 0 ? null : parts.join(" · ");
}

function stepsNoun(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
