import { compact, partition } from "es-toolkit/array";
import { getExtensionCatalog } from "#src/lib/extensions";
import {
  type EventMetadata,
  type ExtensionCatalog,
  findAction,
  findEvent,
} from "@rova/shared/extensions/catalog";
import {
  type ConditionFieldDefinition,
  type ConditionFieldType,
  EVENT_NAME_FIELD_PATH,
} from "@rova/shared/conditions/conditions";
import { eventsReaching } from "@rova/shared/graph/events-reaching";
import {
  fieldsVisibleForConfig,
  type ReferenceField,
  type UpstreamField,
} from "@rova/shared/graph/node-references";
import {
  type ReachableField,
  reachableEventFields,
} from "@rova/shared/graph/reachable-fields";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import { upstreamNodeIds } from "@rova/shared/graph/upstream-nodes";
import { readConfigString } from "@rova/shared/graph/node-config";

export type ConditionSelectableField = ConditionFieldDefinition & {
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeLabels: string[];
  nullable?: boolean;
  enumValues?: string[];
};

/**
 * A field together with the picker section it belongs under, where that differs
 * from the name of the node producing it.
 *
 * The entry node is the only source needing one: several Events can reach a
 * single node, and a path only some of them declare belongs under those Events
 * rather than beside the paths all of them carry.
 */
export type SourcedField = Omit<ReachableField, "declaredBy"> & {
  sourceLabel?: string;
  /** The Events reaching the node that leave this path out, by label. */
  absentOn?: string[];
};

/** One upstream field, under the node that produced it. */
export type SelectableUpstreamField = Omit<SourcedField, "sourceLabel"> & {
  sourceNodeId: string;
  sourceNodeName: string;
};

/** The section holding the paths every Event reaching a node declares. */
const SHARED_EVENT_FIELDS_LABEL = "Carried by every Event";

/** What the picker calls the field naming the Event a run arrived on. */
const EVENT_NAME_FIELD_LABEL = "Event name";

/**
 * Every path any of these Events declares, each offered once, under the section
 * saying which runs can answer it.
 *
 * The reconciliation itself is `reachableEventFields`, which the save reads too.
 * What is added here is presentation: the section a path sits under, and the
 * Events it is missing from, both by the label a builder sees.
 */
function entryPayloadFields(events: readonly EventMetadata[]): SourcedField[] {
  return reachableEventFields(events).map(({ declaredBy, ...field }) => {
    const [declaring, absent] = partition(events, (event) =>
      declaredBy.includes(event.name)
    );

    return {
      ...field,
      ...(absent.length > 0
        ? { absentOn: absent.map((event) => event.label) }
        : {}),
      // One Event reaching the node leaves one section, which is the node's own
      // name and needs no label of its own.
      ...(events.length < 2
        ? {}
        : {
            sourceLabel:
              absent.length === 0
                ? SHARED_EVENT_FIELDS_LABEL
                : declaring.map((event) => event.label).join(", "),
          }),
    };
  });
}

/** The Events that could have put a run at this node, as the editor asks it. */
export function eventsReachingTarget(request: FieldRequest): EventMetadata[] {
  return eventsReaching({
    targetNodeId: request.targetNodeId,
    nodes: request.nodes,
    edges: request.edges,
    catalog: getExtensionCatalog(),
  });
}

function getPluginActionOutputFields(actionType: string): ReferenceField[] {
  const action = findAction(getExtensionCatalog(), actionType);

  return action ? [...action.outputFields] : [];
}

export function getNodeDisplayName(node: WorkflowNode): string {
  if (node.data.label) {
    return node.data.label;
  }

  if (node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      const action = findAction(getExtensionCatalog(), actionType);
      if (action?.label) {
        return action.label;
      }
    }

    return actionType || "Action";
  }

  if (node.data.type === "lifecycle") {
    return "Lifecycle";
  }

  return "Node";
}

/**
 * Where in the graph the fields are being asked for.
 *
 * The entry node is the reason this exists: what it offers depends on the node
 * asking, because the path between the two decides which Events could have put a
 * run there. Every other node answers from its own config or its catalog entry.
 * The nodes come along because that path is read off their configs.
 */
export type FieldRequest = {
  targetNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
};

export function getNodeOutputFields(
  node: WorkflowNode,
  request: FieldRequest
): SourcedField[] {
  const actionType = readConfigString(node.data.config, "actionType");

  if (actionType) {
    const pluginFields = getPluginActionOutputFields(actionType);
    if (pluginFields.length > 0) {
      return [...fieldsVisibleForConfig(node.data.config, pluginFields)];
    }
  }

  // The entry node's output is the payload of whichever Event put the run here,
  // so what it offers is every path the Events that still could have declare,
  // each carrying what they agree on.
  if (node.data.type === "lifecycle") {
    return entryPayloadFields(eventsReachingTarget(request));
  }

  // An action type the catalog cannot find -- a stale graph naming a plugin
  // action this build no longer ships -- has no declared schema to read fields
  // from, so there is nothing addressable to offer.
  return [];
}

/** The nodes a run passed through before this one, in canvas order. */
export function getUpstreamNodes(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): WorkflowNode[] {
  const { currentNodeId, nodes, edges } = input;
  if (!currentNodeId) {
    return [];
  }

  const upstreamIds = upstreamNodeIds(currentNodeId, edges);
  return nodes.filter((node) => upstreamIds.has(node.id));
}

export function getUpstreamFields(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): SelectableUpstreamField[] {
  // The one narrowing: an entry node's answer names the node asking, so the id has
  // to be a string by the time the fields are read.
  const { currentNodeId, nodes, edges } = input;
  if (!currentNodeId) {
    return [];
  }

  return getUpstreamNodes(input).flatMap((node) => {
    const sourceNodeName = getNodeDisplayName(node);

    return getNodeOutputFields(node, {
      targetNodeId: currentNodeId,
      nodes,
      edges,
    }).map(({ sourceLabel, ...field }) => ({
      ...field,
      sourceNodeId: node.id,
      sourceNodeName: sourceLabel ?? sourceNodeName,
    }));
  });
}

function toConditionFieldType(field: UpstreamField): ConditionFieldType | null {
  if (field.type === "timestamp" || field.format === "timestamp") {
    return "timestamp";
  }

  if (
    field.type === "string" ||
    field.type === "number" ||
    field.type === "boolean"
  ) {
    return field.type;
  }

  // A duration is a string on the wire, and the condition vocabulary has no
  // operators for a length of time, so a rule compares the written form.
  if (field.type === "duration") {
    return "string";
  }

  // Fields without an explicit type (common for custom action outputFields) default to string
  if (field.type === undefined) {
    return "string";
  }

  return null;
}

/**
 * The typed vocabulary a Wait node's match editor builds rules from: the fields
 * of the Event being waited on, as the catalog declares them.
 *
 * The source label is the Event itself rather than a node, because a match reads
 * a payload that has not arrived yet: no node in this graph produces it. An Event
 * the catalog has never heard of has no declared fields, and the editor says so
 * rather than offering a vocabulary it made up.
 */
export function getEventConditionFields(
  catalog: ExtensionCatalog,
  eventName: string
): ConditionSelectableField[] {
  const event = findEvent(catalog, eventName);
  if (!event) {
    return [];
  }

  return compact(
    event.payloadFields.map((field) => {
      const path = field.path.trim();
      const type = toConditionFieldType({
        ...field,
        sourceNodeId: eventName,
        sourceNodeName: event.label,
      });
      if (!(path && type)) {
        return null;
      }

      return {
        path,
        label: path,
        type,
        sourceNodeId: eventName,
        sourceNodeLabel: event.label,
        sourceNodeLabels: [event.label],
        ...(field.nullable ? { nullable: true } : {}),
        ...(field.enumValues ? { enumValues: field.enumValues } : {}),
      };
    })
  ).toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * The field a rule names the arriving Event by, offered only where more than one
 * Event can put a run at this node: behind the Canceled outlet, and wherever a
 * workflow names several Start Events. One Event leaves nothing to select
 * between.
 *
 * It belongs to the condition picker alone. A template token resolves against a
 * node's output, and the Event's name is a fact about the run rather than
 * anything the entry node hands on.
 */
function eventNameConditionField(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): ConditionSelectableField[] {
  const { currentNodeId, nodes, edges } = input;
  const entryNode = getUpstreamNodes(input).find(
    (node) => node.data.type === "lifecycle"
  );
  if (!(entryNode && currentNodeId)) {
    return [];
  }

  const events = eventsReachingTarget({
    targetNodeId: currentNodeId,
    nodes,
    edges,
  });
  if (events.length < 2) {
    return [];
  }

  return [
    {
      path: EVENT_NAME_FIELD_PATH,
      label: EVENT_NAME_FIELD_LABEL,
      type: "string",
      sourceNodeId: entryNode.id,
      sourceNodeLabel: SHARED_EVENT_FIELDS_LABEL,
      sourceNodeLabels: [SHARED_EVENT_FIELDS_LABEL],
      enumValues: events.map((event) => event.name),
    },
  ];
}

export function getUpstreamConditionFields(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): ConditionSelectableField[] {
  const fieldsByPath = new Map<string, ConditionSelectableField>(
    eventNameConditionField(input).map((field) => [field.path, field])
  );

  for (const field of getUpstreamFields(input)) {
    const path = field.path.trim();
    // A path the reaching Events type differently has no type to build a rule
    // over. Splitting on `$event.name` is what leaves one Event, and one type.
    if (!path || field.typeClash) {
      continue;
    }

    const conditionFieldType = toConditionFieldType(field);
    if (!conditionFieldType) {
      continue;
    }

    const existing = fieldsByPath.get(path);
    if (existing) {
      if (!existing.sourceNodeLabels.includes(field.sourceNodeName)) {
        existing.sourceNodeLabels.push(field.sourceNodeName);
        existing.sourceNodeLabels.sort((a, b) => a.localeCompare(b));
      }
      continue;
    }

    fieldsByPath.set(path, {
      path,
      label: path,
      type: conditionFieldType,
      sourceNodeId: field.sourceNodeId,
      sourceNodeLabel: field.sourceNodeName,
      sourceNodeLabels: [field.sourceNodeName],
      ...(field.nullable ? { nullable: true } : {}),
      ...(field.enumValues ? { enumValues: field.enumValues } : {}),
    });
  }

  return Array.from(fieldsByPath.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
}
