/**
 * Which Events could have put a run at a given node.
 *
 * The editor asks this to decide what a node may address: the payloads of these
 * Events, and the values a rule about the arriving Event can select between.
 */

import { compact, uniqBy } from "es-toolkit/array";
import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import {
  type ConditionModel,
  type ConditionRule,
  EVENT_NAME_FIELD_PATH,
  isNullCheckConditionRule,
  isStringSetConditionRule,
  parseConditionModel,
} from "#src/conditions/conditions";
import {
  type EventMetadata,
  type ExtensionCatalog,
  findAction,
  findEvent,
} from "#src/extensions/catalog";
import type {
  ConditionBranch,
  WorkflowEdge,
  WorkflowNode,
} from "#src/graph/types";
import {
  isEventWaitNode,
  isLifecycleNode,
  readConfigString,
} from "#src/graph/node-config";
import { fieldsVisibleForConfig } from "#src/graph/node-references";
import { upstreamNodeIds } from "#src/graph/upstream-nodes";
import {
  eventSplitOutletEvent,
  isEventSplitNode,
} from "#src/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";
import { readLifecycleRules } from "#src/lifecycle/lifecycle-rules";
import { readWaitSubscriptions } from "#src/lifecycle/wait-subscription";

/**
 * Whether one rule could hold for a run that arrived on this Event.
 *
 * Two rules say something about which Event arrived. One names it. The other
 * names a payload field, which only an Event declaring that field can satisfy,
 * because a rule about a field the payload lacks reads false.
 *
 * `declaredElsewhere` are the paths the actions upstream also produce. A
 * condition reads the run's outputs merged flat, so such a path may be an
 * action's rather than the payload's, and it then says nothing about the Event.
 */
function ruleCouldHold(input: {
  rule: ConditionRule;
  event: EventMetadata;
  declaredElsewhere: ReadonlySet<string>;
}): boolean {
  const { rule, event } = input;
  const path = rule.field.trim();

  if (path === EVENT_NAME_FIELD_PATH) {
    if (isNullCheckConditionRule(rule)) {
      return true;
    }
    if (rule.operator === "equals") {
      return rule.value === event.name;
    }
    if (rule.operator === "not_equals") {
      return rule.value !== event.name;
    }
    if (isStringSetConditionRule(rule)) {
      return rule.operator === "is_one_of"
        ? rule.values.includes(event.name)
        : !rule.values.includes(event.name);
    }
    return true;
  }

  // Presence is answerable either way for any Event: one that leaves the field
  // out satisfies `is_not_set`, and one that declares it may still carry null.
  if (isNullCheckConditionRule(rule)) {
    return true;
  }

  if (input.declaredElsewhere.has(path)) {
    return true;
  }

  return event.payloadFields.some((field) => field.path === path);
}

/**
 * Whether one rule could fail for a run that arrived on this Event.
 *
 * Almost anything can: a comparison fails on some payload, and a rule about a
 * field the Event never declares fails on every one. A rule naming the Event
 * itself is the exception, because for a given Event it has only one answer.
 */
function ruleCouldFail(input: {
  rule: ConditionRule;
  event: EventMetadata;
}): boolean {
  const { rule, event } = input;

  if (
    rule.field.trim() !== EVENT_NAME_FIELD_PATH ||
    isNullCheckConditionRule(rule)
  ) {
    return true;
  }

  if (rule.operator === "equals") {
    return rule.value !== event.name;
  }

  if (rule.operator === "not_equals") {
    return rule.value === event.name;
  }

  if (isStringSetConditionRule(rule)) {
    return rule.operator === "is_one_of"
      ? !rule.values.includes(event.name)
      : rule.values.includes(event.name);
  }

  return true;
}

type ModelQuestion = {
  model: ConditionModel;
  event: EventMetadata;
  declaredElsewhere: ReadonlySet<string>;
};

/**
 * Whether the model could hold for one Event.
 *
 * Rules are weighed one at a time, so a conjunction whose parts are separately
 * satisfiable counts as satisfiable. That overstates what could hold, which
 * keeps an Event rather than dropping it, and keeping is the safe direction.
 */
function modelCouldHold(input: ModelQuestion): boolean {
  const groupCouldHold = (
    conditions: readonly ConditionRule[],
    all: boolean
  ) =>
    all
      ? conditions.every((rule) => ruleCouldHold({ ...input, rule }))
      : conditions.some((rule) => ruleCouldHold({ ...input, rule }));

  const answers = input.model.groups.map((group) =>
    groupCouldHold(group.conditions, group.logic === "and")
  );

  return input.model.groupLogic === "and"
    ? answers.every(Boolean)
    : answers.some(Boolean);
}

/**
 * Whether the model could fail for one Event, which is the question the false
 * line asks. It is the mirror of `modelCouldHold`: a conjunction fails when any
 * part does, a disjunction only when every part does.
 */
function modelCouldFail(input: ModelQuestion): boolean {
  const groupCouldFail = (
    conditions: readonly ConditionRule[],
    all: boolean
  ) =>
    all
      ? conditions.some((rule) => ruleCouldFail({ ...input, rule }))
      : conditions.every((rule) => ruleCouldFail({ ...input, rule }));

  const answers = input.model.groups.map((group) =>
    groupCouldFail(group.conditions, group.logic === "and")
  );

  return input.model.groupLogic === "and"
    ? answers.some(Boolean)
    : answers.every(Boolean);
}

/** The answer a rule can determine from an absent Arriving Event alone. */
function ruleAnswerWithoutEvent(rule: ConditionRule): boolean | undefined {
  if (rule.field.trim() !== EVENT_NAME_FIELD_PATH) {
    return undefined;
  }

  if (isNullCheckConditionRule(rule)) {
    return rule.operator === "is_not_set";
  }

  if (rule.operator === "equals" || rule.operator === "contains") {
    return false;
  }
  if (rule.operator === "not_equals") {
    return true;
  }
  if (isStringSetConditionRule(rule)) {
    return rule.operator === "is_not_one_of";
  }

  return undefined;
}

/** Whether components with these possible answers can compose to `expected`. */
function canComposeAnswer(
  possible: readonly boolean[],
  logic: "and" | "or",
  expected: boolean
): boolean {
  if (logic === "and") {
    return expected ? possible.every(Boolean) : possible.some(Boolean);
  }
  return expected ? possible.some(Boolean) : possible.every(Boolean);
}

/** Whether unknown payload values could let an Event-less run take this branch. */
function modelCouldAnswerWithoutEvent(
  model: ConditionModel,
  expected: boolean
): boolean {
  const groups = model.groups.map((group) =>
    canComposeAnswer(
      group.conditions.map((rule) => {
        const answer = ruleAnswerWithoutEvent(rule);
        return answer === undefined || answer === expected;
      }),
      group.logic,
      expected
    )
  );
  return canComposeAnswer(groups, model.groupLogic, expected);
}

/**
 * The Events still possible past one line out of a Condition node.
 *
 * An Event survives the true line when the model could hold for it, and the
 * false line when it could fail. A model this cannot read narrows nothing, for
 * the same reason the walk below keeps an Event it is unsure about.
 */
function narrowThroughCondition(input: {
  events: readonly EventMetadata[];
  node: WorkflowNode;
  branch: ConditionBranch | null;
  declaredElsewhere: ReadonlySet<string>;
}): EventMetadata[] {
  const { events, branch } = input;
  if (!branch) {
    return [...events];
  }

  const parsed = parseConditionModel(input.node.data.config?.conditionModel);
  if (!parsed.valid) {
    return [...events];
  }

  return events.filter((event) => {
    const question = {
      model: parsed.model,
      event,
      declaredElsewhere: input.declaredElsewhere,
    };

    return branch === "true"
      ? modelCouldHold(question)
      : modelCouldFail(question);
  });
}

/**
 * The Events an event-mode Wait hands on, in the order its subscriptions name
 * them. A delay Wait never reaches this: it is not an event source, so the walk
 * keeps whatever reached the Wait.
 *
 * An Event the catalog has never heard of is skipped, matching the Lifecycle
 * Node. Saving refuses a wait that names one.
 */
function waitEvents(input: {
  node: WorkflowNode;
  catalog: ExtensionCatalog;
}): EventMetadata[] {
  return compact(
    readWaitSubscriptions(input.node.data.config).map((subscription) =>
      findEvent(input.catalog, subscription.event)
    )
  );
}

/** The Events an outlet of the entry node hands on, in the order rules name them. */
function outletEvents(input: {
  entryNode: WorkflowNode;
  handle: unknown;
  catalog: ExtensionCatalog;
}): EventMetadata[] {
  const rules = readLifecycleRules(input.entryNode.data.config);
  if (!rules) {
    return [];
  }

  const names =
    input.handle === LIFECYCLE_STARTED_HANDLE
      ? rules.startEvents
      : input.handle === LIFECYCLE_CANCELED_HANDLE
        ? rules.cancelEvents
        : [];

  // An Event the catalog has never heard of is skipped. Saving refuses a rules
  // declaration naming one, so it belongs to a graph that cannot run.
  return compact(names.map((name) => findEvent(input.catalog, name)));
}

/** The output paths an action node produces, empty for anything else. */
function actionOutputPaths(
  node: WorkflowNode,
  catalog: ExtensionCatalog
): string[] {
  const actionType = node.data.config?.actionType;
  if (typeof actionType !== "string") {
    return [];
  }

  const action = findAction(catalog, actionType);
  if (!action) {
    return [];
  }

  return fieldsVisibleForConfig(node.data.config, action.outputFields).map(
    (field) => field.path
  );
}

/**
 * A node that names the Events a run below it can arrive on: the Lifecycle
 * Node through its Started or Canceled outlet, or an event-mode Wait.
 */
export type ArrivingEventSource =
  | { kind: "lifecycle"; nodeId: string; side: "started" | "canceled" }
  | { kind: "wait"; nodeId: string };

/** The Events at a node, and the nearest Event sources above it they came from. */
type Reaching = {
  events: EventMetadata[];
  sources: ArrivingEventSource[];
};

const REACHES_NOTHING: Reaching = { events: [], sources: [] };

/**
 * The Events that could have put a run at this node, narrowed by the Conditions
 * it sits behind, with the nearest Event sources those Events came from.
 *
 * Events at a node are the intersection of what each incoming edge admits, the
 * same AND the engine uses for readiness. A parent that is the Lifecycle Node
 * contributes its outlet's Events; a parent that is an event-mode Wait
 * contributes the Events it parks on, which is how an Event Split below it has
 * something new to split; anything else is narrowed by the handle the edge left
 * on. A node no path reaches is offered nothing. The sources are every source
 * any incoming path stops at, each listed once.
 *
 * Where the walk cannot tell, it keeps the Event. Offering a field too many is
 * noise a builder can read past; hiding one is a promise they cannot see broken.
 */
function walkEventsReaching(input: {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): Reaching {
  const { catalog } = input;
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, WorkflowEdge[]>();
  for (const edge of input.edges) {
    const list = incomingByTarget.get(edge.target);
    if (list) {
      list.push(edge);
    } else {
      incomingByTarget.set(edge.target, [edge]);
    }
  }

  const outputPathsAt = (nodeId: string): Set<string> => {
    const paths = new Set<string>();
    const add = (id: string) => {
      const node = nodeById.get(id);
      if (!node) {
        return;
      }
      for (const path of actionOutputPaths(node, catalog)) {
        paths.add(path);
      }
    };
    add(nodeId);
    for (const ancestorId of upstreamNodeIds(nodeId, input.edges)) {
      add(ancestorId);
    }
    return paths;
  };

  const memo = new Map<string, Reaching>();

  const reachingAt = (nodeId: string, seen: Set<string>): Reaching => {
    const cached = memo.get(nodeId);
    if (cached) {
      return cached;
    }
    if (seen.has(nodeId)) {
      return REACHES_NOTHING;
    }

    const incoming = incomingByTarget.get(nodeId) ?? [];
    if (incoming.length === 0) {
      memo.set(nodeId, REACHES_NOTHING);
      return REACHES_NOTHING;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);

    let acc: Reaching | null = null;
    for (const edge of incoming) {
      const parent = nodeById.get(edge.source);
      if (!parent) {
        continue;
      }

      const fromParent = reachingFromParent({
        parent,
        handle: edge.sourceHandle,
        catalog,
        above: reachingAt(parent.id, nextSeen),
        declaredElsewhere: outputPathsAt(parent.id),
      });

      acc =
        acc === null
          ? fromParent
          : {
              events: intersectEventsByName(acc.events, fromParent.events),
              sources: uniqBy(
                [...acc.sources, ...fromParent.sources],
                sourceKey
              ),
            };
    }

    const result = acc ?? REACHES_NOTHING;
    memo.set(nodeId, result);
    return result;
  };

  return reachingAt(input.targetNodeId, new Set());
}

/** One string per source, which two paths reaching the same source share. */
function sourceKey(source: ArrivingEventSource): string {
  return source.kind === "lifecycle"
    ? `${source.nodeId}:${source.side}`
    : source.nodeId;
}

/** The Events that could have put a run at this node. */
export function eventsReaching(input: {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): EventMetadata[] {
  return walkEventsReaching(input).events;
}

/**
 * The nearest Event sources above this node, which name the Events
 * `eventsReaching` answers for it. An Event Split's outlets are owned by these
 * nodes. Empty when no path from a source reaches the node.
 */
export function arrivingEventSources(input: {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): ArrivingEventSource[] {
  return walkEventsReaching(input).sources;
}

/**
 * What one parent contributes to the Events at a child.
 *
 * A Lifecycle Node and an event-mode Wait are sources: they name the Events
 * they hand on, and the walk does not keep what reached them. Everything else
 * narrows the inherited set and passes on the sources above it.
 */
function reachingFromParent(input: {
  parent: WorkflowNode;
  handle: unknown;
  catalog: ExtensionCatalog;
  above: Reaching;
  declaredElsewhere: ReadonlySet<string>;
}): Reaching {
  const { parent, catalog } = input;

  if (isLifecycleNode(parent)) {
    const side =
      input.handle === LIFECYCLE_STARTED_HANDLE
        ? "started"
        : input.handle === LIFECYCLE_CANCELED_HANDLE
          ? "canceled"
          : null;
    return {
      events: outletEvents({
        entryNode: parent,
        handle: input.handle,
        catalog,
      }),
      sources: side ? [{ kind: "lifecycle", nodeId: parent.id, side }] : [],
    };
  }

  if (isEventWaitNode(parent)) {
    return {
      events: waitEvents({ node: parent, catalog }),
      sources: [{ kind: "wait", nodeId: parent.id }],
    };
  }

  return {
    events: narrowLeaving({
      parent,
      handle: input.handle,
      events: input.above.events,
      declaredElsewhere: input.declaredElsewhere,
    }),
    sources: input.above.sources,
  };
}

function narrowLeaving(input: {
  parent: WorkflowNode;
  handle: unknown;
  events: EventMetadata[];
  declaredElsewhere: ReadonlySet<string>;
}): EventMetadata[] {
  const { parent, handle, events } = input;

  if (isEventSplitNode(parent)) {
    const outletEvent = eventSplitOutletEvent(handle);
    return events.filter((event) => event.name === outletEvent);
  }

  if (events.length > 0 && isConditionActionNode(parent)) {
    return narrowThroughCondition({
      events,
      node: parent,
      branch: normalizeConditionBranch(handle),
      declaredElsewhere: input.declaredElsewhere,
    });
  }

  return events;
}

function intersectEventsByName(
  left: readonly EventMetadata[],
  right: readonly EventMetadata[]
): EventMetadata[] {
  const rightNames = new Set(right.map((event) => event.name));
  return left.filter((event) => rightNames.has(event.name));
}

/**
 * Whether a run can reach this node carrying no Arriving Event.
 *
 * An event-mode Wait that continues past its timeout releases the run without
 * an Event, and the engine writes an empty payload onto the Lifecycle Node for
 * everything below it. Every path the Wait's Events declare is therefore absent
 * on that run, which is exactly what `nullable` on a Reachable Field says. A
 * Wait set to skip on timeout releases no such run, so it answers false.
 *
 * The question is asked per node rather than per field, because the timeout is
 * a fact about the walk down to the node and not about any one payload path.
 */
export function arrivingEventCanBeAbsent(input: {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): boolean {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, WorkflowEdge[]>();
  for (const edge of input.edges) {
    const list = incomingByTarget.get(edge.target);
    if (list) {
      list.push(edge);
    } else {
      incomingByTarget.set(edge.target, [edge]);
    }
  }

  const memo = new Map<string, boolean>();

  const absentAt = (nodeId: string, seen: Set<string>): boolean => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (seen.has(nodeId)) {
      return false;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);

    // Any one path that loses the Event is enough, because a run takes one path
    // and the field is absent on that run.
    const answer = (incomingByTarget.get(nodeId) ?? []).some((edge) => {
      const parent = nodeById.get(edge.source);
      if (!parent) {
        return false;
      }
      if (isEventWaitNode(parent)) {
        return continuesPastTimeout(parent);
      }
      // The Lifecycle Node is the other Event source, and a run entering there
      // carries the Event that opened it. An Event Split releases only a run
      // naming the Event on one of its outlets, so an absent Event stops there.
      if (isLifecycleNode(parent) || isEventSplitNode(parent)) {
        return false;
      }
      if (isConditionActionNode(parent)) {
        const branch = normalizeConditionBranch(edge.sourceHandle);
        const parsed = parseConditionModel(parent.data.config?.conditionModel);
        if (
          branch &&
          parsed.valid &&
          !modelCouldAnswerWithoutEvent(parsed.model, branch === "true")
        ) {
          return false;
        }
      }
      return absentAt(parent.id, nextSeen);
    });

    memo.set(nodeId, answer);
    return answer;
  };

  return absentAt(input.targetNodeId, new Set());
}

/** Whether a timed-out run leaves this Wait, which is the default behavior. */
function continuesPastTimeout(node: WorkflowNode): boolean {
  return readConfigString(node.data.config, "waitTimeoutBehavior") !== "skip";
}
