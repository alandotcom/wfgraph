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
  compileConditionModel,
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
  event: EventMetadata | null;
  declaredElsewhere: ReadonlySet<string>;
}): boolean {
  const { rule, event } = input;
  const path = rule.field.trim();

  if (event === null) {
    if (path === EVENT_NAME_FIELD_PATH) {
      return ruleAnswerWithoutEvent(rule) ?? true;
    }
    if (input.declaredElsewhere.has(path)) {
      return true;
    }
    return isNullCheckConditionRule(rule)
      ? rule.operator === "is_not_set"
      : false;
  }

  if (path === EVENT_NAME_FIELD_PATH) {
    if (isNullCheckConditionRule(rule)) {
      return rule.operator === "is_set";
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
  event: EventMetadata | null;
  declaredElsewhere: ReadonlySet<string>;
}): boolean {
  const { rule, event } = input;
  const path = rule.field.trim();

  if (event === null) {
    if (path === EVENT_NAME_FIELD_PATH) {
      const answer = ruleAnswerWithoutEvent(rule);
      return answer === undefined || !answer;
    }
    if (input.declaredElsewhere.has(path)) {
      return true;
    }
    return isNullCheckConditionRule(rule) ? rule.operator === "is_set" : true;
  }

  if (path !== EVENT_NAME_FIELD_PATH) {
    return true;
  }
  if (isNullCheckConditionRule(rule)) {
    return rule.operator === "is_not_set";
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
  event: EventMetadata | null;
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
  const groupCouldHold = (group: ConditionModel["groups"][number]) =>
    group.logic === "and"
      ? group.conditions.every((rule) => ruleCouldHold({ ...input, rule }))
      : group.conditions.some((rule) => ruleCouldHold({ ...input, rule }));

  return input.model.groupLogic === "and"
    ? input.model.groups.every(groupCouldHold)
    : input.model.groups.some(groupCouldHold);
}

/**
 * Whether the model could fail for one Event, which is the question the false
 * line asks. It is the mirror of `modelCouldHold`: a conjunction fails when any
 * part does, a disjunction only when every part does.
 */
function modelCouldFail(input: ModelQuestion): boolean {
  const groupCouldFail = (group: ConditionModel["groups"][number]) =>
    group.logic === "and"
      ? group.conditions.some((rule) => ruleCouldFail({ ...input, rule }))
      : group.conditions.every((rule) => ruleCouldFail({ ...input, rule }));

  return input.model.groupLogic === "and"
    ? input.model.groups.some(groupCouldFail)
    : input.model.groups.every(groupCouldFail);
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

/**
 * The Events still possible past one line out of a Condition node.
 *
 * An Event survives the true line when the model could hold for it, and the
 * false line when it could fail. A model this cannot read narrows nothing, for
 * the same reason the walk below keeps an Event it is unsure about.
 */
function narrowThroughCondition(input: {
  events: readonly EventMetadata[];
  model: ConditionModel;
  branch: ConditionBranch;
  declaredElsewhere: ReadonlySet<string>;
}): EventMetadata[] {
  return input.events.filter((event) => {
    const question = {
      model: input.model,
      event,
      declaredElsewhere: input.declaredElsewhere,
    };

    return input.branch === "true"
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

/** The Events at a node, whether one can be absent, and their nearest sources. */
type Reaching = {
  events: EventMetadata[];
  eventCanBeAbsent: boolean;
  sources: ArrivingEventSource[];
};

const REACHES_NOTHING: Reaching = {
  events: [],
  eventCanBeAbsent: false,
  sources: [],
};

/**
 * The Events that could have put a run at this node, narrowed by the Conditions
 * it sits behind, with the nearest Event sources those Events came from.
 *
 * Events at a node are the intersection of what each incoming edge admits, the
 * same AND the engine uses for readiness. An absent Event likewise reaches a
 * join only when every incoming edge admits it. A parent that is the Lifecycle
 * Node contributes its outlet's Events; a parent that is an event-mode Wait
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

    // This is the active recursion stack, not every node ever visited. Sharing
    // it across synchronous calls avoids copying an increasingly large Set at
    // every level; `finally` removes the node before a sibling branch runs.
    seen.add(nodeId);
    try {
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
          above: reachingAt(parent.id, seen),
          declaredElsewhere: outputPathsAt(parent.id),
        });

        acc =
          acc === null
            ? fromParent
            : {
                events: intersectEventsByName(acc.events, fromParent.events),
                eventCanBeAbsent:
                  acc.eventCanBeAbsent && fromParent.eventCanBeAbsent,
                sources: uniqBy(
                  [...acc.sources, ...fromParent.sources],
                  sourceKey
                ),
              };
      }

      const result = acc ?? REACHES_NOTHING;
      memo.set(nodeId, result);
      return result;
    } finally {
      seen.delete(nodeId);
    }
  };

  return reachingAt(input.targetNodeId, new Set());
}

/** One string per source, which two paths reaching the same source share. */
function sourceKey(source: ArrivingEventSource): string {
  return source.kind === "lifecycle"
    ? `${source.nodeId}:${source.side}`
    : source.nodeId;
}

export type ArrivingEventReachability = {
  events: EventMetadata[];
  eventCanBeAbsent: boolean;
};

/** The Events that can reach a node, including a timeout that names none. */
export function arrivingEventReachability(input: {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): ArrivingEventReachability {
  const reaching = walkEventsReaching(input);
  return {
    events: reaching.events,
    eventCanBeAbsent: reaching.eventCanBeAbsent,
  };
}

/** The Events that could have put a run at this node. */
export function eventsReaching(input: {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): EventMetadata[] {
  return arrivingEventReachability(input).events;
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
      eventCanBeAbsent: false,
      sources: side ? [{ kind: "lifecycle", nodeId: parent.id, side }] : [],
    };
  }

  if (isEventWaitNode(parent)) {
    return {
      events: waitEvents({ node: parent, catalog }),
      eventCanBeAbsent: continuesPastTimeout(parent),
      sources: [{ kind: "wait", nodeId: parent.id }],
    };
  }

  return narrowLeaving({
    parent,
    handle: input.handle,
    above: input.above,
    declaredElsewhere: input.declaredElsewhere,
  });
}

function narrowLeaving(input: {
  parent: WorkflowNode;
  handle: unknown;
  above: Reaching;
  declaredElsewhere: ReadonlySet<string>;
}): Reaching {
  const { parent, handle, above } = input;

  if (isEventSplitNode(parent)) {
    const outletEvent = eventSplitOutletEvent(handle);
    return {
      ...above,
      events: above.events.filter((event) => event.name === outletEvent),
      eventCanBeAbsent: false,
    };
  }

  if (!isConditionActionNode(parent)) {
    return above;
  }

  const branch = normalizeConditionBranch(handle);
  const parsed = parseConditionModel(parent.data.config?.conditionModel);
  if (!(branch && parsed.valid)) {
    return above;
  }

  const events = narrowThroughCondition({
    events: above.events,
    model: parsed.model,
    branch,
    declaredElsewhere: input.declaredElsewhere,
  });
  const compiled = compileConditionModel(parsed.model);
  const question = {
    model: parsed.model,
    event: null,
    declaredElsewhere: input.declaredElsewhere,
  };
  const eventCanBeAbsent =
    above.eventCanBeAbsent &&
    (!compiled.valid ||
      (branch === "true"
        ? modelCouldHold(question)
        : modelCouldFail(question)));

  return { ...above, events, eventCanBeAbsent };
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
  catalog: ExtensionCatalog;
}): boolean {
  return arrivingEventReachability(input).eventCanBeAbsent;
}

/** Whether a timed-out run leaves this Wait, which is the default behavior. */
function continuesPastTimeout(node: WorkflowNode): boolean {
  return readConfigString(node.data.config, "waitTimeoutBehavior") !== "skip";
}
