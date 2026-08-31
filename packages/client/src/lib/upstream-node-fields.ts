import { compact, partition, uniq } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import {
  type EventMetadata,
  type ExtensionCatalog,
  findAction,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import {
  type ConditionFieldDefinition,
  type ConditionFieldType,
  EVENT_NAME_FIELD_PATH,
} from "@wfgraph/shared/conditions/conditions";
import { eventsReaching } from "@wfgraph/shared/graph/events-reaching";
import { fieldsVisibleForConfig } from "@wfgraph/shared/graph/node-references";
import {
  type ReachableField,
  reachableEventFields,
} from "@wfgraph/shared/graph/reachable-fields";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  collectOpenRecordKeys,
  keysForRecord,
} from "#src/lib/open-record-keys";
import { upstreamNodeIds } from "@wfgraph/shared/graph/upstream-nodes";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
import { getNodeDisplayName } from "@wfgraph/shared/graph/node-display";
import type {
  WorkflowSchemaFieldType,
  WorkflowSchemaItemType,
} from "@wfgraph/shared/graph/schema-codec";

export { getNodeDisplayName };

export type ConditionSelectableField = ConditionFieldDefinition & {
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeLabels: string[];
  nullable?: boolean;
  enumValues?: string[];
  /** Human labels for `enumValues`, keyed by the stored comparison value. */
  enumLabels?: Readonly<Record<string, string>>;
  /**
   * The record a graph-derived key sits under, and the key itself.
   *
   * A row like `tags.name` is a shortcut for a record plus a key the graph
   * happens to name, so it carries the split the rule stores rather than
   * leaving the picker to take the path apart again.
   */
  recordPath?: string;
  recordKey?: string;
};

/**
 * The field a rule names.
 *
 * A rule stores the path the picker offered and, for an open record, its key
 * beside it, so every path a rule holds is one this list already carries. The
 * lookup is therefore exact: what is left for this function is saying so in one
 * place, which is what keeps the picker, the summary and the reconcile from
 * disagreeing about whether a rule still points at anything.
 */
export function conditionFieldForPath(
  fields: readonly ConditionSelectableField[],
  path: string
): ConditionSelectableField | undefined {
  return fields.find((field) => field.path === path);
}

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
  /**
   * Whose vocabulary this path belongs to, where an integration owns it. Read
   * only for an open record, to scope the keys the graph fills it with
   * (`open-record-keys.ts`), so one integration's rows never name another's.
   */
  integration?: string;
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

    // The declaring Events agreeing on one owner is what makes the path that
    // owner's. Two integrations declaring it leaves it owned by neither, which
    // is the same stance `reachableEventFields` takes on a clashing type.
    const owners = uniq(compact(declaring.map((event) => event.integration)));

    return {
      ...field,
      ...(owners.length === 1 ? { integration: owners[0] } : {}),
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
    catalog: request.catalog,
  });
}

function getPluginActionOutputFields(
  catalog: ExtensionCatalog,
  actionType: string
): SourcedField[] {
  const action = findAction(catalog, actionType);
  if (!action) {
    return [];
  }

  return action.outputFields.map((field) => ({
    ...field,
    ...(action.integration ? { integration: action.integration } : {}),
  }));
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
  catalog: ExtensionCatalog;
};

export function getNodeOutputFields(
  node: WorkflowNode,
  request: FieldRequest
): SourcedField[] {
  const actionType = readConfigString(node.data.config, "actionType");

  if (actionType) {
    const pluginFields = getPluginActionOutputFields(
      request.catalog,
      actionType
    );
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
  catalog: ExtensionCatalog;
}): SelectableUpstreamField[] {
  // The one narrowing: an entry node's answer names the node asking, so the id has
  // to be a string by the time the fields are read.
  const { currentNodeId, nodes, edges, catalog } = input;
  if (!currentNodeId) {
    return [];
  }

  return getUpstreamNodes(input).flatMap((node) => {
    const sourceNodeName = getNodeDisplayName(catalog, node);

    return getNodeOutputFields(node, {
      targetNodeId: currentNodeId,
      nodes,
      edges,
      catalog,
    }).map(({ sourceLabel, ...field }) => ({
      ...field,
      sourceNodeId: node.id,
      sourceNodeName: sourceLabel ?? sourceNodeName,
    }));
  });
}

function toConditionFieldType(field: {
  type?: WorkflowSchemaFieldType;
}): ConditionFieldType | null {
  if (field.type === "timestamp") {
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
 * The rule vocabulary one catalog field offers, records included.
 *
 * An open record is an object, and an object has no operators, so reading its
 * own type would drop it. What a rule actually compares is a key under it, so
 * the record answers with the type its values carry and the row asks for the
 * key. Anything else answers for itself.
 */
function conditionTypeOf(field: {
  type?: WorkflowSchemaFieldType;
  valueType?: WorkflowSchemaItemType;
}): ConditionFieldType | null {
  return toConditionFieldType(
    field.valueType ? { type: field.valueType } : field
  );
}

/**
 * The rows a record's known keys become, beside the record itself.
 *
 * The record entry stays, because a key nothing in this graph writes is still a
 * key somebody can name. What is added is the keys the graph does write, which
 * is the difference between a picker offering only "a tag" and one offering
 * `tags.name` because a Send Email node upstream set it.
 *
 * Each row carries the split a rule stores, so choosing one writes the same rule
 * as choosing the record and typing the key. Nullable, because a record promises
 * no particular key: the node that fills it may not have run on the path this
 * rule is read on, and an email tagged elsewhere carries whatever it carries.
 */
function keyFieldsUnderRecord(
  record: ConditionSelectableField,
  keys: readonly string[]
): ConditionSelectableField[] {
  return keys.map((key) => ({
    ...omit(record, ["openRecord"]),
    path: `${record.path}.${key}`,
    label: `${record.path}.${key}`,
    recordPath: record.path,
    recordKey: key,
    nullable: true,
  }));
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
  eventName: string,
  // The Event's own payload is the vocabulary. The nodes come along for its open
  // records alone: the tags a `resend/email.delivered` carries are the tags a
  // Send Email node in this workflow set, so the graph is where their names are.
  // Required rather than defaulted, because a caller that forgot it would get a
  // picker quietly missing every key the graph names.
  nodes: readonly WorkflowNode[]
): ConditionSelectableField[] {
  const event = findEvent(catalog, eventName);
  if (!event) {
    return [];
  }

  const graphKeys = collectOpenRecordKeys(nodes, catalog);

  return compact(
    event.payloadFields.flatMap((field) => {
      const path = field.path.trim();
      const type = conditionTypeOf(field);
      if (!(path && type)) {
        return [null];
      }

      const entry: ConditionSelectableField = {
        path,
        label: path,
        type,
        sourceNodeId: eventName,
        sourceNodeLabel: event.label,
        sourceNodeLabels: [event.label],
        ...(field.valueType ? { openRecord: true as const } : {}),
        ...(field.nullable ? { nullable: true } : {}),
        ...(field.enumValues ? { enumValues: field.enumValues } : {}),
      };

      return field.valueType
        ? [
            entry,
            ...keyFieldsUnderRecord(
              entry,
              keysForRecord(graphKeys, event.integration, path)
            ),
          ]
        : [entry];
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
  catalog: ExtensionCatalog;
}): ConditionSelectableField[] {
  const { currentNodeId, nodes, edges, catalog } = input;
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
    catalog,
  });
  const fields: ConditionSelectableField[] = [];
  if (events.length >= 2) {
    fields.push({
      path: EVENT_NAME_FIELD_PATH,
      label: EVENT_NAME_FIELD_LABEL,
      type: "string",
      sourceNodeId: entryNode.id,
      sourceNodeLabel: SHARED_EVENT_FIELDS_LABEL,
      sourceNodeLabels: [SHARED_EVENT_FIELDS_LABEL],
      enumValues: events.map((event) => event.name),
      enumLabels: Object.fromEntries(
        events.map((event) => [event.name, event.label])
      ),
    });
  }
  return fields;
}

export function getUpstreamConditionFields(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  catalog: ExtensionCatalog;
}): ConditionSelectableField[] {
  const fieldsByPath = new Map<string, ConditionSelectableField>(
    eventNameConditionField(input).map((field) => [field.path, field])
  );
  const graphKeys = collectOpenRecordKeys(input.nodes, input.catalog);

  for (const field of getUpstreamFields(input)) {
    const path = field.path.trim();
    // A path the reaching Events type differently has no type to build a rule
    // over. Splitting on `$event.name` is what leaves one Event, and one type.
    if (!path || field.typeClash) {
      continue;
    }

    const conditionFieldType = conditionTypeOf(field);
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

    const entry: ConditionSelectableField = {
      path,
      label: path,
      type: conditionFieldType,
      sourceNodeId: field.sourceNodeId,
      sourceNodeLabel: field.sourceNodeName,
      sourceNodeLabels: [field.sourceNodeName],
      ...(field.valueType ? { openRecord: true as const } : {}),
      ...(field.nullable ? { nullable: true } : {}),
      ...(field.enumValues ? { enumValues: field.enumValues } : {}),
    };
    fieldsByPath.set(path, entry);

    if (!field.valueType) {
      continue;
    }

    // The keys this graph fills the record with, offered beside it. A path
    // already listed stays as it is: a schema declaring it says more than a
    // config row naming it.
    for (const keyField of keyFieldsUnderRecord(
      entry,
      keysForRecord(graphKeys, field.integration, path)
    )) {
      if (!fieldsByPath.has(keyField.path)) {
        fieldsByPath.set(keyField.path, keyField);
      }
    }
  }

  return Array.from(fieldsByPath.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
}
