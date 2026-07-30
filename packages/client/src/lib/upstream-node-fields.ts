import { compact } from "es-toolkit/array";
import { getExtensionCatalog } from "#src/lib/extensions";
import {
  type ExtensionCatalog,
  findAction,
  findEvent,
} from "@rova/shared/extensions/catalog";
import type {
  ConditionFieldDefinition,
  ConditionFieldType,
} from "@rova/shared/workflow/conditions";
import {
  entryOutletsReaching,
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/workflow/lifecycle-outlets";
import { readLifecycleRules } from "@rova/shared/workflow/lifecycle-rules";
import {
  flattenSchemaToReferenceFields,
  type ReferenceField,
  type UpstreamField,
} from "@rova/shared/workflow/node-references";
import { parseWorkflowSchemaFieldsString } from "@rova/shared/workflow/schema-codec";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";
import { upstreamNodeIds } from "@rova/shared/workflow/upstream-nodes";

/** First declaration of a path wins, so defaults stay ahead of schema extras. */
function dedupeByPath(fields: ReferenceField[]): ReferenceField[] {
  const fieldsByPath = new Map<string, ReferenceField>();

  for (const field of fields) {
    if (!fieldsByPath.has(field.path)) {
      fieldsByPath.set(field.path, field);
    }
  }

  return Array.from(fieldsByPath.values());
}

const DEFAULT_HTTP_OUTPUT_FIELDS: ReferenceField[] = [
  { path: "body", description: "Response body", type: "object" },
  {
    path: "status",
    description: "HTTP status code",
    type: "number",
  },
];

const DEFAULT_DATABASE_OUTPUT_FIELDS: ReferenceField[] = [
  { path: "rows", description: "Query result rows", type: "array" },
  {
    path: "count",
    description: "Number of rows",
    type: "number",
  },
];

export type ConditionSelectableField = ConditionFieldDefinition & {
  description: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeLabels: string[];
  nullable?: boolean;
  enumValues?: string[];
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function readSchemaFields(schemaString: string | undefined): ReferenceField[] {
  if (!schemaString) {
    return [];
  }

  const schema = parseWorkflowSchemaFieldsString(schemaString);
  if (schema.length === 0) {
    return [];
  }

  return flattenSchemaToReferenceFields(schema);
}

function getHttpRequestOutputFields(
  config: Record<string, unknown> | undefined
): ReferenceField[] {
  const outputSchemaFields = readSchemaFields(
    readConfigString(config, "httpOutputSchema")
  );

  if (outputSchemaFields.length === 0) {
    return DEFAULT_HTTP_OUTPUT_FIELDS;
  }

  return dedupeByPath([...DEFAULT_HTTP_OUTPUT_FIELDS, ...outputSchemaFields]);
}

function getDatabaseQueryOutputFields(
  config: Record<string, unknown> | undefined
): ReferenceField[] {
  const outputSchemaFields = readSchemaFields(
    readConfigString(config, "dbOutputSchema")
  );

  if (outputSchemaFields.length > 0) {
    return outputSchemaFields;
  }

  return DEFAULT_DATABASE_OUTPUT_FIELDS;
}

/**
 * The fields every one of these Events carries, by path.
 *
 * Only the common paths qualify: a field some of the Events leave out resolves to
 * nothing on the runs that arrived as one of those, so offering it would be a
 * promise the payload does not keep.
 *
 * A common path keeps its declared type only where every Event agrees on it, the
 * `format` included, because the type is what decides a condition row's operators
 * and a rule built against one Event would be unanswerable on a run that arrived
 * as another. Disagreement leaves the path offered as text, which is what a
 * template renders it to in any case, and gives the condition builder the string
 * operators every payload can answer.
 *
 * An Event the catalog has never heard of is skipped. Saving refuses a rules
 * declaration naming one, so it belongs to a graph that cannot run, and the
 * picker's job is to offer what it can name.
 */
function commonPayloadFields(
  eventNames: readonly string[],
  catalog: ExtensionCatalog
): ReferenceField[] {
  const perEvent = compact(
    eventNames.map((name) => findEvent(catalog, name)?.payloadFields)
  );

  const [first, ...rest] = perEvent;
  if (!first) {
    return [];
  }

  return compact(
    first.map((field) => {
      const declarations = rest.map((fields) =>
        fields.find((other) => other.path === field.path)
      );
      if (declarations.some((other) => other === undefined)) {
        return undefined;
      }

      const agreed = declarations.every(
        (other) => other?.type === field.type && other?.format === field.format
      );
      // Null on any of them is null on the field, which is what puts the
      // is-set operators on its condition row.
      const nullable =
        field.nullable || declarations.some((other) => other?.nullable);

      return {
        ...(agreed
          ? field
          : {
              path: field.path,
              description: field.description,
              type: "string" as const,
            }),
        ...(nullable ? { nullable: true } : {}),
      };
    })
  );
}

/**
 * What the entry node offers a particular node downstream of it.
 *
 * The entry node's output is the payload of the Event that started or canceled
 * the run, and which of those a node receives depends on the outlet it sits
 * behind: the Start Events' fields behind Started, the Cancel Events' behind
 * Canceled, and the fields common to both where a branch rejoins. Every Event a
 * run could have arrived as goes into one intersection, which is the same rule
 * whether the multiplicity comes from several Start Events or from two outlets.
 *
 * A node the entry node cannot reach through a named outlet is offered nothing.
 * The save refuses an entry-node edge that names no outlet, so an unnamed one
 * describes a graph that cannot run.
 */
function getEntryNodeOutputFields(input: {
  entryNode: WorkflowNode;
  targetNodeId: string;
  edges: WorkflowEdge[];
}): ReferenceField[] {
  const rules = readLifecycleRules(input.entryNode.data.config);
  if (!rules) {
    return [];
  }

  const outlets = entryOutletsReaching({
    entryNodeId: input.entryNode.id,
    targetNodeId: input.targetNodeId,
    edges: input.edges,
  });

  return commonPayloadFields(
    [
      ...(outlets.has(LIFECYCLE_STARTED_HANDLE) ? rules.startEvents : []),
      ...(outlets.has(LIFECYCLE_CANCELED_HANDLE) ? rules.cancelEvents : []),
    ],
    getExtensionCatalog()
  );
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

    return actionType || "HTTP Request";
  }

  if (node.data.type === "trigger") {
    return "Trigger";
  }

  return "Node";
}

/**
 * Where in the graph the fields are being asked for.
 *
 * The entry node is the reason this exists: what it offers depends on the node
 * asking, because the outlet between the two decides which Events' payloads can
 * arrive. Every other node answers from its own config or its catalog entry.
 */
export type FieldRequest = {
  targetNodeId: string;
  edges: WorkflowEdge[];
};

export function getNodeOutputFields(
  node: WorkflowNode,
  request: FieldRequest
): ReferenceField[] {
  const actionType = readConfigString(node.data.config, "actionType");

  if (actionType === "HTTP Request") {
    return getHttpRequestOutputFields(node.data.config);
  }

  if (actionType === "Database Query") {
    return getDatabaseQueryOutputFields(node.data.config);
  }

  if (actionType) {
    const pluginFields = getPluginActionOutputFields(actionType);
    if (pluginFields.length > 0) {
      return pluginFields;
    }
  }

  if (node.data.type === "trigger") {
    return getEntryNodeOutputFields({
      entryNode: node,
      targetNodeId: request.targetNodeId,
      edges: request.edges,
    });
  }

  return [{ path: "data", description: "Output data" }];
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
}): UpstreamField[] {
  // The one narrowing: an entry node's answer names the node asking, so the id has
  // to be a string by the time the fields are read.
  const { currentNodeId, edges } = input;
  if (!currentNodeId) {
    return [];
  }

  return getUpstreamNodes(input).flatMap((node) => {
    const sourceNodeName = getNodeDisplayName(node);

    return getNodeOutputFields(node, {
      targetNodeId: currentNodeId,
      edges,
    }).map((field) => ({
      ...field,
      sourceNodeId: node.id,
      sourceNodeName,
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
        description: field.description,
        sourceNodeId: eventName,
        sourceNodeLabel: event.label,
        sourceNodeLabels: [event.label],
        ...(field.nullable ? { nullable: true } : {}),
        ...(field.enumValues ? { enumValues: field.enumValues } : {}),
      };
    })
  ).toSorted((a, b) => a.path.localeCompare(b.path));
}

export function getUpstreamConditionFields(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): ConditionSelectableField[] {
  const fieldsByPath = new Map<string, ConditionSelectableField>();

  for (const field of getUpstreamFields(input)) {
    const path = field.path.trim();
    if (!path) {
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
      description: field.description,
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
