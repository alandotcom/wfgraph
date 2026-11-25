/**
 * What a workflow does, in sentences built from its stored graph and the
 * extension catalog: what starts a run, the steps a run takes in order, and
 * what stops a run in progress. Every word is a label the builder or the
 * catalog wrote, or a phrase the editor's panels use, so the account never
 * shows an id. A branch nested deeper than `MAX_LINE_DEPTH` is folded into one
 * phrase with its step count, which keeps a large graph's account short.
 */

import { compact, uniq } from "es-toolkit/array";
import {
  BUILT_IN_ACTION_IDS,
  isBuiltInActionId,
} from "#src/actions/built-in-actions";
import { normalizeConditionBranch } from "#src/conditions/condition-branch";
import {
  EVENT_NAME_FIELD_PATH,
  parseEntityStateConditionPath,
  parseNodeOutputConditionPath,
} from "#src/conditions/condition-model";
import {
  NUMBER_OPERATOR_OPTIONS,
  STRING_OPERATOR_OPTIONS,
  STRING_SET_OPERATOR_OPTIONS,
} from "#src/conditions/condition-options";
import {
  type ConditionModel,
  type ConditionRule,
  isNullCheckConditionRule,
  isStringSetConditionRule,
  isTimestampRelativeConditionRule,
  parseConditionModel,
} from "#src/conditions/conditions";
import {
  type ExtensionCatalog,
  findAction,
  findEntity,
  findEvent,
} from "#src/extensions/catalog";
import { isGroupNode } from "#src/graph/group-boundary";
import {
  actionTypeOf,
  isLifecycleNode,
  readConfigString,
} from "#src/graph/node-config";
import { getNodeDisplayName } from "#src/graph/node-display";
import {
  parseTemplate,
  type ReferenceField,
  referenceFieldLabel,
} from "#src/graph/node-references";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { cronShape, describeCronSchedule } from "#src/lifecycle/cron-schedule";
import {
  eventSplitOutlet,
  eventSplitOutletEvent,
} from "#src/lifecycle/event-split";
import {
  type LifecycleRules,
  manualStartAllowed,
  readLifecycleRules,
} from "#src/lifecycle/lifecycle-rules";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";
import { readCancelFilter } from "#src/lifecycle/cancel-filters";
import { readStartFilter } from "#src/lifecycle/start-filters";
import {
  readWaitDelayTiming,
  readWaitSubscriptions,
} from "#src/lifecycle/wait-subscription";
import { isBlank } from "#src/types/string";
import { parseDurationMs } from "#src/utils/wait-time";

/** One line of the account, with the lines of the branches it opens. */
export type WorkflowSummaryLine = {
  /** Unique among the line's siblings, for keying a rendered list. */
  key: string;
  text: string;
  children: readonly WorkflowSummaryLine[];
};

export type WorkflowSummary = {
  /** What starts a run, one sentence each. Never empty. */
  starts: readonly string[];
  /** What a run does, in order. Empty when nothing follows the Started outlet. */
  steps: readonly WorkflowSummaryLine[];
  /** What stops a run in progress, one sentence per Cancel Event filter. */
  stops: readonly string[];
};

/**
 * How deep branch lines nest. A branch that would open a line deeper than this
 * is written as one phrase naming how many paths and steps it holds.
 */
const MAX_LINE_DEPTH = 2;

/** How many steps a branch names before it counts the rest. */
const MAX_BRANCH_STEPS = 5;

/**
 * The account of the workflow made of `nodes` and `edges`. A graph with no
 * Lifecycle node says that nothing starts it.
 */
export function summarizeWorkflow(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): WorkflowSummary {
  const graph = indexGraph(input);
  const lifecycle = input.nodes.find(isLifecycleNode);
  const rules = readLifecycleRules(lifecycle?.data.config);
  const started = lifecycle
    ? follow(graph, outletUnits(graph, lifecycle.id, LIFECYCLE_STARTED_HANDLE))
    : [];
  const canceled = lifecycle
    ? follow(graph, outletUnits(graph, lifecycle.id, LIFECYCLE_CANCELED_HANDLE))
    : [];
  return {
    starts: startSentences(rules, input.catalog),
    steps: started.map((item) => topLine(item)),
    stops: stopSentences(rules, input.catalog, canceled),
  };
}

/**
 * The phrase a Condition card and the account use for a Condition holding more
 * than one rule, such as "All of 2 rules". Null for one rule, no rules, or
 * rules that cannot be read, where there is nothing hidden to point at.
 */
export function conditionRulesPhrase(
  config: Record<string, unknown> | undefined
): string | null {
  const stored = readConfigString(config, "conditionModel");
  if (stored === undefined || isBlank(stored)) {
    return null;
  }
  const parsed = parseConditionModel(stored);
  if (!parsed.valid) {
    return null;
  }
  const { model } = parsed;
  const [onlyGroup] = model.groups;
  if (model.groups.length === 1 && onlyGroup) {
    const count = onlyGroup.conditions.length;
    if (count < 2) {
      return null;
    }
    return `${onlyGroup.logic === "and" ? "All" : "Any"} of ${count} rules`;
  }
  const count = model.groups.length;
  return count < 2
    ? null
    : `${model.groupLogic === "and" ? "All" : "Any"} of ${count} groups`;
}

// ---------------------------------------------------------------------------
// Reading the graph into a path of items.

/**
 * The graph as the walk reads it. A unit is a node id, or a Group's id for
 * every member of that Group, since the account names a Group as one item.
 */
type Graph = {
  catalog: ExtensionCatalog;
  nodesById: Map<string, WorkflowNode>;
  edgesBySource: Map<string, WorkflowEdge[]>;
  membersByGroup: Map<string, WorkflowNode[]>;
  /** Units entered from more than one other unit, which a walk stops at. */
  joins: Set<string>;
  /** Units the walk has described, so no unit is written twice. */
  visited: Set<string>;
};

/** One thing a run passes through, keyed by the unit that starts it. */
type Item = { key: string } & ItemBody;

type ItemBody =
  | { kind: "step"; label: string }
  | { kind: "disabled"; label: string }
  | { kind: "wait"; label: string; timing: string | null }
  | { kind: "group"; label: string; stepCount: number }
  | {
      kind: "guard";
      label: string;
      rules: string | null;
      /** The branch that ends, which the account names. */
      ends: "True" | "False";
    }
  | {
      kind: "condition";
      label: string;
      rules: string | null;
      onTrue: Item[];
      onFalse: Item[];
    }
  | { kind: "split"; label: string; outlets: { label: string; path: Item[] }[] }
  | { kind: "parallel"; paths: Item[][] };

function indexGraph(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): Graph {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const graph: Graph = {
    catalog: input.catalog,
    nodesById,
    edgesBySource: Map.groupBy(input.edges, (edge) => edge.source),
    membersByGroup: Map.groupBy(
      input.nodes.filter(
        (node) =>
          node.parentId !== undefined &&
          isGroupNode(nodesById.get(node.parentId)) &&
          node.data.type !== "add"
      ),
      (node) => node.parentId ?? ""
    ),
    joins: new Set(),
    visited: new Set(),
  };
  const sourcesByUnit = new Map<string, Set<string>>();
  for (const edge of input.edges) {
    const source = unitOf(graph, edge.source);
    const target = unitOf(graph, edge.target);
    if (source === target) {
      continue;
    }
    const sources = sourcesByUnit.get(target) ?? new Set();
    sources.add(source);
    sourcesByUnit.set(target, sources);
  }
  for (const [unit, sources] of sourcesByUnit) {
    if (sources.size > 1) {
      graph.joins.add(unit);
    }
  }
  return graph;
}

function unitOf(graph: Graph, nodeId: string): string {
  const parentId = graph.nodesById.get(nodeId)?.parentId;
  return parentId !== undefined && isGroupNode(graph.nodesById.get(parentId))
    ? parentId
    : nodeId;
}

/** The units the edges leaving `nodeId` reach, by outlet when one is named. */
function outletUnits(
  graph: Graph,
  nodeId: string,
  handle?: string | null
): string[] {
  const edges = graph.edgesBySource.get(nodeId) ?? [];
  return uniq(
    edges
      .filter((edge) => handle === undefined || edge.sourceHandle === handle)
      .map((edge) => unitOf(graph, edge.target))
      .filter((unit) => graph.nodesById.get(unit)?.data.type !== "add")
  );
}

/**
 * The items a run passes through from `units`. Several units run side by side.
 * A walk stops at a unit it already described and at a join, and then hands the
 * join to the item that opened the branches, which carries on from it.
 */
function follow(graph: Graph, units: readonly string[]): Item[] {
  let walked = walk(graph, units, undefined);
  const items = [...walked.items];
  // A join whose other predecessors this walk never reaches is still where
  // the run goes next, so the top level carries on from it.
  while (walked.join !== undefined && !graph.visited.has(walked.join)) {
    walked = walk(graph, [walked.join], walked.join);
    items.push(...walked.items);
  }
  return items;
}

function walk(
  graph: Graph,
  units: readonly string[],
  enteringJoin: string | undefined
): { items: Item[]; join: string | undefined } {
  const items: Item[] = [];
  let frontier = units;
  let allowedJoin = enteringJoin;
  for (;;) {
    if (frontier.length > 1) {
      const branches = frontier.map((unit) => walk(graph, [unit], undefined));
      items.push({
        key: `paths:${frontier.join(",")}`,
        kind: "parallel",
        paths: branches.map((branch) => branch.items),
      });
      const join = openJoin(graph, branches);
      if (join === undefined) {
        return { items, join: undefined };
      }
      frontier = [join];
      allowedJoin = join;
      continue;
    }
    const [unit] = frontier;
    if (unit === undefined || graph.visited.has(unit)) {
      return { items, join: undefined };
    }
    if (graph.joins.has(unit) && unit !== allowedJoin) {
      return { items, join: unit };
    }
    allowedJoin = undefined;
    graph.visited.add(unit);
    const described = describeUnit(graph, unit);
    if (described === undefined) {
      return { items, join: undefined };
    }
    items.push({ ...described.item, key: unit });
    frontier = described.next;
    if (described.join !== undefined) {
      allowedJoin = described.join;
    }
  }
}

/** The first join a set of branches stopped at that nothing has described. */
function openJoin(
  graph: Graph,
  branches: readonly { join: string | undefined }[]
): string | undefined {
  return branches
    .map((branch) => branch.join)
    .find((join) => join !== undefined && !graph.visited.has(join));
}

/**
 * One unit as an item, with the units the walk goes on to. A unit that opens
 * branches walks them itself and goes on from the join they meet at, if any.
 */
function describeUnit(
  graph: Graph,
  unit: string
): { item: ItemBody; next: string[]; join?: string | undefined } | undefined {
  const node = graph.nodesById.get(unit);
  if (!node || isLifecycleNode(node)) {
    return undefined;
  }
  const label = stepLabel(graph.catalog, node);
  if (isGroupNode(node)) {
    const members = graph.membersByGroup.get(unit) ?? [];
    const memberIds = new Set(members.map((member) => member.id));
    const next = uniq(
      members.flatMap((member) =>
        outletUnits(graph, member.id).filter((target) => !memberIds.has(target))
      )
    ).filter((target) => target !== unit);
    return { item: { kind: "group", label, stepCount: members.length }, next };
  }
  if (node.data.enabled === false) {
    return { item: { kind: "disabled", label }, next: [] };
  }
  const actionType = actionTypeOf(node);
  if (actionType === BUILT_IN_ACTION_IDS.wait) {
    return {
      item: { kind: "wait", label, timing: waitTiming(graph, node) },
      next: outletUnits(graph, unit),
    };
  }
  if (actionType === BUILT_IN_ACTION_IDS.condition) {
    return describeCondition(graph, node, label);
  }
  if (actionType === BUILT_IN_ACTION_IDS.eventSplit) {
    return describeSplit(graph, node, label);
  }
  return { item: { kind: "step", label }, next: outletUnits(graph, unit) };
}

/**
 * What the account calls a step: its label, else its action's catalog label.
 * An action the catalog does not hold is named as such, since its id is not a
 * word a reader knows.
 */
export function stepLabel(
  catalog: ExtensionCatalog,
  node: WorkflowNode
): string {
  if (!isBlank(node.data.label) || isGroupNode(node)) {
    return getNodeDisplayName(catalog, node);
  }
  const actionType = actionTypeOf(node);
  if (actionType === undefined || isBlank(actionType)) {
    return "a step with no action chosen";
  }
  return isBuiltInActionId(actionType)
    ? actionType
    : (findAction(catalog, actionType)?.label ??
        "an action this app does not offer");
}

function describeCondition(
  graph: Graph,
  node: WorkflowNode,
  label: string
): { item: ItemBody; next: string[]; join?: string | undefined } {
  const rules = conditionRulesPhrase(node.data.config);
  const edges = graph.edgesBySource.get(node.id) ?? [];
  const unitsOn = (branch: "true" | "false") =>
    uniq(
      edges
        .filter(
          (edge) => normalizeConditionBranch(edge.sourceHandle) === branch
        )
        .map((edge) => unitOf(graph, edge.target))
    );
  const onTrue = unitsOn("true");
  const onFalse = unitsOn("false");
  if (onTrue.length === 0 || onFalse.length === 0) {
    return {
      item: {
        kind: "guard",
        label,
        rules,
        ends: onTrue.length === 0 ? "True" : "False",
      },
      next: onTrue.length === 0 ? onFalse : onTrue,
    };
  }
  const branches = [
    walk(graph, onTrue, undefined),
    walk(graph, onFalse, undefined),
  ];
  const join = openJoin(graph, branches);
  return {
    item: {
      kind: "condition",
      label,
      rules,
      onTrue: branches[0]?.items ?? [],
      onFalse: branches[1]?.items ?? [],
    },
    next: join === undefined ? [] : [join],
    join,
  };
}

function describeSplit(
  graph: Graph,
  node: WorkflowNode,
  label: string
): { item: ItemBody; next: string[]; join?: string | undefined } {
  const edges = graph.edgesBySource.get(node.id) ?? [];
  const eventNames = uniq(
    compact(edges.map((edge) => eventSplitOutletEvent(edge.sourceHandle)))
  );
  const outlets = eventNames.map((eventName) => ({
    label: eventLabel(graph.catalog, eventName),
    walked: walk(
      graph,
      outletUnits(graph, node.id, eventSplitOutlet(eventName)),
      undefined
    ),
  }));
  const join = openJoin(
    graph,
    outlets.map((outlet) => outlet.walked)
  );
  return {
    item: {
      kind: "split",
      label,
      outlets: outlets.map((outlet) => ({
        label: outlet.label,
        path: outlet.walked.items,
      })),
    },
    next: join === undefined ? [] : [join],
    join,
  };
}

// ---------------------------------------------------------------------------
// Writing items as lines.

/** A line of the top-level sequence. */
function topLine(item: Item): WorkflowSummaryLine {
  const { key } = item;
  switch (item.kind) {
    case "guard":
      return leaf(
        key,
        `Checks “${item.label}”${rulesNote(item.rules)} and ends the run if ${item.ends}.`
      );
    case "disabled":
      return leaf(key, `${item.label} is disabled, so the run ends here.`);
    case "condition":
      return {
        key,
        text: `Checks “${item.label}”${rulesNote(item.rules)}:`,
        children: [
          prefixed("If True", branchLine(item.onTrue, 1, `${key}:true`)),
          prefixed("If False", branchLine(item.onFalse, 1, `${key}:false`)),
        ],
      };
    case "split":
      return {
        key,
        text: `“${item.label}” picks a path by the Event that arrived:`,
        children: item.outlets.map((outlet) =>
          prefixed(
            outlet.label,
            branchLine(outlet.path, 1, `${key}:${outlet.label}`)
          )
        ),
      };
    case "parallel":
      return {
        key,
        text: `Runs ${item.paths.length} paths at the same time:`,
        children: item.paths.map((path, index) =>
          branchLine(path, 1, `${key}:${index}`)
        ),
      };
    default:
      return leaf(key, capitalize(fragment(item)));
  }
}

/**
 * One branch at `depth`, as one line. Its steps read as a run-on sequence. A
 * split or a set of side-by-side paths inside it opens child lines while
 * `depth` allows, and is folded into a phrase past that.
 */
function branchLine(
  path: readonly Item[],
  depth: number,
  emptyKey: string
): WorkflowSummaryLine {
  const key = path[0]?.key ?? emptyKey;
  if (path.length === 0) {
    return leaf(key, "The path ends.");
  }
  const opensAt = path.findIndex(
    (item) => item.kind === "split" || item.kind === "parallel"
  );
  if (opensAt === -1 || depth >= MAX_LINE_DEPTH) {
    return leaf(key, `${capitalize(sequenceText(path))}.`);
  }
  const before = path.slice(0, opensAt);
  const opener = path[opensAt];
  const after = path.slice(opensAt + 1);
  const intro =
    opener?.kind === "split"
      ? `“${opener.label}” picks a path by the Event that arrived:`
      : `${opener?.kind === "parallel" ? opener.paths.length : 0} paths run at the same time:`;
  const children =
    opener?.kind === "split"
      ? opener.outlets.map((outlet) =>
          prefixed(
            outlet.label,
            branchLine(outlet.path, depth + 1, `${key}:${outlet.label}`)
          )
        )
      : opener?.kind === "parallel"
        ? opener.paths.map((branch, index) =>
            branchLine(branch, depth + 1, `${key}:${index}`)
          )
        : [];
  const text =
    before.length === 0
      ? capitalize(intro)
      : `${capitalize(sequenceText(before))}, then ${lowerFirst(intro)}`;
  return {
    key,
    text,
    children:
      after.length === 0
        ? children
        : [
            ...children,
            leaf(`${key}:after`, `After that: ${sequenceText(after)}.`),
          ],
  };
}

/**
 * Items as one run-on phrase: "A, then B, then C". A Condition with both
 * branches connected writes each branch in a sentence of its own, folding
 * anything nested inside them. Past `MAX_BRANCH_STEPS` the rest is counted.
 */
function sequenceText(path: readonly Item[]): string {
  const shown = path.slice(0, MAX_BRANCH_STEPS);
  const hiddenSteps = stepCount(path.slice(MAX_BRANCH_STEPS));
  const parts = shown.map((item) =>
    item.kind === "condition"
      ? `checks “${item.label}”${rulesNote(item.rules)}. If True: ${foldedText(item.onTrue)}. If False: ${foldedText(item.onFalse)}`
      : fragment(item)
  );
  const text = parts.join(", then ");
  return hiddenSteps > 0
    ? `${text}, then ${stepsNoun(hiddenSteps)} more`
    : text;
}

/** Items as one phrase with every nested branch counted rather than written. */
function foldedText(path: readonly Item[]): string {
  if (path.length === 0) {
    return "the path ends";
  }
  const shown = path.slice(0, MAX_BRANCH_STEPS);
  const hiddenSteps = stepCount(path.slice(MAX_BRANCH_STEPS));
  const text = shown
    .map((item) =>
      item.kind === "condition"
        ? `checks “${item.label}”${rulesNote(item.rules)} and branches into ${stepsNoun(stepCount(item.onTrue) + stepCount(item.onFalse))}`
        : fragment(item)
    )
    .join(", then ");
  return hiddenSteps > 0
    ? `${text}, then ${stepsNoun(hiddenSteps)} more`
    : text;
}

/** One item as a phrase inside a sequence, starting lowercase where it is a verb. */
function fragment(item: Item): string {
  switch (item.kind) {
    case "step":
      return item.label;
    case "disabled":
      return `${item.label}, which is disabled, so the path ends`;
    case "wait":
      // A label such as "Wait 2 hours" already says what the timing would.
      return item.timing &&
        !item.label.toLowerCase().includes(item.timing.toLowerCase())
        ? `${item.label} (waits ${item.timing})`
        : item.label;
    case "group":
      return `${item.label}, a Group of ${stepsNoun(item.stepCount)}`;
    case "guard":
      return `checks “${item.label}”${rulesNote(item.rules)} and ends the path if ${item.ends}`;
    case "condition":
      return `checks “${item.label}”${rulesNote(item.rules)} and branches into ${stepsNoun(stepCount(item.onTrue) + stepCount(item.onFalse))}`;
    case "split":
      return `“${item.label}” picks a path by the Event that arrived, across ${stepsNoun(stepCount([item]) - 1)}`;
    default:
      return `${item.paths.length} paths run at the same time, across ${stepsNoun(stepCount([item]))}`;
  }
}

/** How many steps a path holds, counting a Group's members and every branch. */
function stepCount(path: readonly Item[]): number {
  return path.reduce((total, item) => {
    switch (item.kind) {
      case "group":
        return total + item.stepCount;
      case "condition":
        return total + 1 + stepCount(item.onTrue) + stepCount(item.onFalse);
      case "split":
        return (
          total +
          1 +
          item.outlets.reduce((sum, outlet) => sum + stepCount(outlet.path), 0)
        );
      case "parallel":
        return (
          total + item.paths.reduce((sum, branch) => sum + stepCount(branch), 0)
        );
      default:
        return total + 1;
    }
  }, 0);
}

function leaf(key: string, text: string): WorkflowSummaryLine {
  return { key, text, children: [] };
}

function prefixed(
  prefix: string,
  line: WorkflowSummaryLine
): WorkflowSummaryLine {
  return { ...line, text: `${prefix}: ${lowerFirstVerb(line.text)}` };
}

function rulesNote(rules: string | null): string {
  return rules ? ` (${lowerFirst(rules)})` : "";
}

function stepsNoun(count: number): string {
  return count === 1 ? "1 step" : `${count} steps`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * A branch line after its "If True:" or Event prefix keeps a step's label as
 * written and lowercases only the verbs this module writes at a line's start.
 */
function lowerFirstVerb(text: string): string {
  return /^(Checks|The path ends)/u.test(text) ? lowerFirst(text) : text;
}

// ---------------------------------------------------------------------------
// Waits.

/** What reading a Wait's timing needs: the graph's nodes and the catalog. */
type WaitTimingGraph = {
  nodesById: ReadonlyMap<string, WorkflowNode>;
  catalog: ExtensionCatalog;
};

/**
 * How long a Wait waits, in words, such as "1 hour 30 minutes" or "until 24
 * hours before Starts at", or null when its settings name no time this can
 * read, such as a duration a template fills in.
 */
export function waitTiming(
  graph: WaitTimingGraph,
  node: WorkflowNode
): string | null {
  const config = node.data.config ?? {};
  if (readConfigString(config, "waitMode") === "event") {
    const events = readWaitSubscriptions(config).map((subscription) =>
      eventLabel(graph.catalog, subscription.event)
    );
    if (events.length === 0) {
      return null;
    }
    const timeout = durationWords(config.waitTimeout);
    const behavior =
      readConfigString(config, "waitTimeoutBehavior") === "skip"
        ? "ends the path"
        : "continues";
    const limit = timeout ? `up to ${timeout} ` : "";
    return `${limit}for ${orList(events)}, and ${behavior} if none arrives`;
  }
  if (readWaitDelayTiming(config) === "duration") {
    return durationWords(config.waitDuration);
  }
  const target = waitTargetWords(graph, config.waitUntil);
  if (target === null) {
    return null;
  }
  const offsetMs = parseDurationMs(config.waitOffset);
  if (offsetMs === null || offsetMs === 0) {
    return `until ${target}`;
  }
  const offset = durationWords(Math.abs(offsetMs));
  return `until ${offset} ${offsetMs < 0 ? "before" : "after"} ${target}`;
}

/**
 * A Wait's target time in words: the label of the field one template reference
 * reads, or a fixed date in UTC.
 */
function waitTargetWords(
  graph: WaitTimingGraph,
  value: unknown
): string | null {
  if (typeof value !== "string" || isBlank(value)) {
    return null;
  }
  const segments = parseTemplate(value.trim());
  const [only] = segments;
  if (segments.length === 1 && only?.kind === "token") {
    return tokenFieldLabel(graph, only.token.nodeId, only.token.fieldPath);
  }
  if (segments.some((segment) => segment.kind === "token")) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : utcDateWords(date);
}

/**
 * The label of the field `fieldPath` names on the node `nodeId`: a Start
 * Event's payload field for the Lifecycle node, an action's output field
 * otherwise, and a label made from the path's last key where neither declares it.
 */
function tokenFieldLabel(
  graph: WaitTimingGraph,
  nodeId: string,
  fieldPath: string
): string {
  const node = graph.nodesById.get(nodeId);
  const declared: readonly ReferenceField[] = isLifecycleNode(node)
    ? (readLifecycleRules(node?.data.config)?.startEvents ?? []).flatMap(
        (name) => findEvent(graph.catalog, name)?.payloadFields ?? []
      )
    : (findAction(graph.catalog, actionTypeOf(node) ?? "")?.outputFields ?? []);
  const field = declared.find((candidate) => candidate.path === fieldPath);
  return referenceFieldLabel(field ?? { path: fieldPath });
}

/** A duration as "90 days" or "1 hour 30 minutes", or null when unreadable. */
function durationWords(value: unknown): string | null {
  const ms = parseDurationMs(value);
  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const units = [
    { ms: 86_400_000, name: "day" },
    { ms: 3_600_000, name: "hour" },
    { ms: 60_000, name: "minute" },
    { ms: 1000, name: "second" },
  ];
  let remaining = Math.round(ms);
  const parts: string[] = [];
  for (const unit of units) {
    const amount = Math.floor(remaining / unit.ms);
    if (amount > 0) {
      parts.push(`${amount} ${unit.name}${amount === 1 ? "" : "s"}`);
      remaining -= amount * unit.ms;
    }
  }
  return parts.length === 0 ? null : parts.join(" ");
}

const UTC_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function utcDateWords(date: Date): string {
  return `${UTC_DATE_FORMAT.format(date).replace(/\s/gu, " ")} UTC`;
}

// ---------------------------------------------------------------------------
// Lifecycle Rules.

/**
 * One thing that starts or stops a run: the Events that share a filter, or a
 * Schedule, as `subject`, and the filter in words as `condition`.
 */
export type LifecycleClause = {
  kind: "event" | "schedule";
  /** "Appointment created or Appointment rescheduled", or "Every Monday at 7:00 AM (UTC)". */
  subject: string;
  /** The filter in words, or null when the Events have none. */
  condition: string | null;
};

/** What starts a run, one clause per filter group of Start Events and per Schedule. */
export function startClauses(
  rules: LifecycleRules | undefined,
  catalog: ExtensionCatalog
): LifecycleClause[] {
  const events = filterGroups(rules?.startEvents ?? [], (name) =>
    rules ? readStartFilter(rules, name) : undefined
  ).map((group): LifecycleClause => ({
    kind: "event",
    subject: orList(group.eventNames.map((name) => eventLabel(catalog, name))),
    condition: filterCondition(group, catalog),
  }));
  const schedules = (rules?.schedules ?? []).map(
    (schedule): LifecycleClause => ({
      kind: "schedule",
      subject:
        cronShape(schedule.cron).kind === "custom"
          ? `On the custom schedule ${schedule.cron} (${schedule.timeZone})`
          : describeCronSchedule(schedule),
      condition: null,
    })
  );
  return [...events, ...schedules];
}

/** What stops a run in progress, one clause per filter group of Cancel Events. */
export function stopClauses(
  rules: LifecycleRules | undefined,
  catalog: ExtensionCatalog
): LifecycleClause[] {
  return filterGroups(rules?.cancelEvents ?? [], (name) =>
    rules ? readCancelFilter(rules, name) : undefined
  ).map((group) => ({
    kind: "event",
    subject: orList(group.eventNames.map((name) => eventLabel(catalog, name))),
    condition: filterCondition(group, catalog),
  }));
}

/**
 * What the Overlapping runs rule does to a run in progress, in the workflow's
 * own nouns: its Start Events and the Entity it tracks, such as "A newer
 * Appointment created for the same Patient ends the run in progress. Its
 * steps not yet reached never run." Null when every arrival starts a run of
 * its own, which ends nothing.
 */
export function overlappingRunsSentence(
  rules: LifecycleRules | undefined,
  catalog: ExtensionCatalog
): string | null {
  if (!rules || rules.concurrency === "unlimited") {
    return null;
  }
  const tracked = rules.trackedEntity;
  const entity = tracked
    ? (findEntity(catalog, tracked.type)?.label ?? tracked.type)
    : null;
  const arrival =
    rules.startEvents.length > 0
      ? orList(rules.startEvents.map((name) => eventLabel(catalog, name)))
      : "start";
  const same = entity === null ? "" : ` for the same ${entity}`;
  return rules.concurrency === "newest-wins"
    ? `A newer ${arrival}${same} ends the run in progress. Its steps not yet reached never run.`
    : `While a run is in progress, a newer ${arrival}${same} starts no run.`;
}

/**
 * What starts a run, one sentence per Start Event group or schedule, such as
 * "Starts when Appointment created arrives, if Status is scheduled.", or one
 * sentence saying a person starts it by hand or that nothing does.
 */
export function startSentences(
  rules: LifecycleRules | undefined,
  catalog: ExtensionCatalog
): string[] {
  const sentences = startClauses(rules, catalog).map((clause) =>
    clause.kind === "event"
      ? `Starts when ${clause.subject} arrives${conditionClause(clause.condition)}.`
      : `Starts ${lowerFirst(clause.subject)}.`
  );
  if (sentences.length > 0) {
    return sentences;
  }
  return [
    manualStartAllowed(rules)
      ? "Starts when someone runs it by hand."
      : "Nothing starts this workflow yet.",
  ];
}

function stopSentences(
  rules: LifecycleRules | undefined,
  catalog: ExtensionCatalog,
  canceled: readonly Item[]
): string[] {
  const clauses = stopClauses(rules, catalog);
  if (clauses.length === 0) {
    return [];
  }
  const sentences = clauses.map(
    (clause) =>
      `${clause.subject} stops a run in progress${conditionClause(clause.condition)}.`
  );
  return canceled.length === 0
    ? sentences
    : [...sentences, `A stopped run then runs ${foldedText(canceled)}.`];
}

type FilterGroup = { eventNames: string[]; filter: string | undefined };

/** Events grouped by the filter they hold, in the order the rules list them. */
function filterGroups(
  eventNames: readonly string[],
  readFilter: (eventName: string) => string | undefined
): FilterGroup[] {
  const byFilter = Map.groupBy(eventNames, (name) => readFilter(name) ?? "");
  return [...byFilter].map(([filter, names]) => ({
    eventNames: names,
    filter: filter === "" ? undefined : filter,
  }));
}

/** ", if Status is one of scheduled or confirmed", or nothing for no filter. */
function conditionClause(condition: string | null): string {
  return condition === null ? "" : `, if ${condition}`;
}

/** "Status is one of scheduled or confirmed", or null for no filter. */
function filterCondition(
  group: FilterGroup,
  catalog: ExtensionCatalog
): string | null {
  if (group.filter === undefined) {
    return null;
  }
  const parsed = parseConditionModel(group.filter);
  if (!parsed.valid) {
    return "its filter matches";
  }
  const events = compact(
    group.eventNames.map((name) => findEvent(catalog, name))
  );
  const fields = events.flatMap((event) => event.payloadFields);
  return modelWords(parsed.model, fields, catalog);
}

// ---------------------------------------------------------------------------
// Filter rules in words.

function modelWords(
  model: ConditionModel,
  fields: readonly ReferenceField[],
  catalog: ExtensionCatalog
): string {
  const groups = model.groups.map((group) => {
    const rules = group.conditions.map((rule) =>
      ruleWords(rule, fields, catalog)
    );
    const joined = rules.join(group.logic === "and" ? ", and " : ", or ");
    return model.groups.length > 1 && rules.length > 1 ? `(${joined})` : joined;
  });
  return groups.join(model.groupLogic === "and" ? " and " : " or ");
}

function ruleWords(
  rule: ConditionRule,
  fields: readonly ReferenceField[],
  catalog: ExtensionCatalog
): string {
  const field = fields.find((candidate) => candidate.path === rule.field);
  const name = ruleFieldLabel(rule, field);
  if (isNullCheckConditionRule(rule)) {
    return `${name} ${rule.operator === "is_set" ? "is set" : "is not set"}`;
  }
  switch (rule.fieldType) {
    case "timestamp":
      if (isTimestampRelativeConditionRule(rule)) {
        const amount = `${rule.amount} ${rule.amount === 1 ? rule.unit.replace(/s$/u, "") : rule.unit}`;
        const relative = {
          within_next: `is within the next ${amount}`,
          more_than_from_now: `is more than ${amount} from now`,
          less_than_ago: `is less than ${amount} ago`,
          more_than_ago: `is more than ${amount} ago`,
        } as const;
        return `${name} ${relative[rule.operator]}`;
      }
      return `${name} is ${rule.operator} ${dateWords(rule.dateTime)}`;
    case "string": {
      const valueText = (value: string) =>
        rule.field === EVENT_NAME_FIELD_PATH
          ? eventLabel(catalog, value)
          : (field?.enumLabels?.[value] ?? value);
      if (isStringSetConditionRule(rule)) {
        return `${name} ${optionLabel(STRING_SET_OPERATOR_OPTIONS, rule.operator)} ${orList(rule.values.map(valueText))}`;
      }
      return `${name} ${optionLabel(STRING_OPERATOR_OPTIONS, rule.operator)} ${valueText(rule.value)}`;
    }
    case "number":
      return `${name} ${optionLabel(NUMBER_OPERATOR_OPTIONS, rule.operator)} ${rule.value}`;
    default:
      return `${name} is ${rule.operator === "is_true" ? "true" : "false"}`;
  }
}

/** What a rule's field is called, never its stored path. */
function ruleFieldLabel(
  rule: ConditionRule,
  field: ReferenceField | undefined
): string {
  const path =
    rule.field === EVENT_NAME_FIELD_PATH
      ? undefined
      : (parseNodeOutputConditionPath(rule.field)?.fieldPath ??
        parseEntityStateConditionPath(rule.field)?.fieldPath ??
        rule.field);
  const label =
    path === undefined ? "Event name" : referenceFieldLabel(field ?? { path });
  return rule.recordKey ? `${label} ${rule.recordKey}` : label;
}

function optionLabel(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function dateWords(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : utcDateWords(date);
}

/** "A", "A or B", "A, B, or C". */
function orList(items: readonly string[]): string {
  if (items.length <= 2) {
    return items.join(" or ");
  }
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

/** An Event's label, or a phrase saying the app no longer declares it. */
export function eventLabel(
  catalog: ExtensionCatalog,
  eventName: string
): string {
  return (
    findEvent(catalog, eventName)?.label ??
    "an Event this app no longer declares"
  );
}
