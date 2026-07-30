import { getExtensionCatalog } from "#src/lib/extensions";
import { findAction } from "@rova/shared/extensions/catalog";
import type {
  ConditionFieldDefinition,
  ConditionFieldType,
} from "@rova/shared/workflow/conditions";
import {
  flattenSchemaToReferenceFields,
  type ReferenceField,
  type UpstreamField,
} from "@rova/shared/workflow/node-references";
import { parseWorkflowSchemaFieldsString } from "@rova/shared/workflow/schema-codec";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";

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
  { path: "data", description: "Response data", type: "object" },
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

const DEFAULT_TRIGGER_OUTPUT_FIELDS: ReferenceField[] = [
  {
    path: "triggered",
    description: "Trigger status",
    type: "boolean",
  },
  {
    path: "timestamp",
    description: "Trigger timestamp",
    type: "timestamp",
  },
  { path: "input", description: "Input data", type: "object" },
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

function readOutputSchemaString(
  config: Record<string, unknown> | undefined,
  outputSchemaKey: string
): string | undefined {
  return readConfigString(config, outputSchemaKey);
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
    readOutputSchemaString(config, "httpOutputSchema")
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
    readOutputSchemaString(config, "dbOutputSchema")
  );

  if (outputSchemaFields.length > 0) {
    return outputSchemaFields;
  }

  return DEFAULT_DATABASE_OUTPUT_FIELDS;
}

/**
 * What the entry node offers downstream nodes.
 *
 * The narrowed output contract the builder wrote, over the fields every run
 * carries. There is no per-trigger-type arm: an entry node has one payload shape
 * now, and B5 replaces the hand-written one with the Start Events' own fields.
 */
function getTriggerOutputFields(node: WorkflowNode): ReferenceField[] {
  const outputSchemaFields = readSchemaFields(
    readOutputSchemaString(node.data.config, "webhookOutputSchema")
  );

  return outputSchemaFields.length === 0
    ? DEFAULT_TRIGGER_OUTPUT_FIELDS
    : dedupeByPath([...DEFAULT_TRIGGER_OUTPUT_FIELDS, ...outputSchemaFields]);
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

export function getNodeOutputFields(node: WorkflowNode): ReferenceField[] {
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
    return getTriggerOutputFields(node);
  }

  return [{ path: "data", description: "Output data" }];
}

export function getUpstreamNodes(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): WorkflowNode[] {
  const { currentNodeId, nodes, edges } = input;
  if (!currentNodeId) {
    return [];
  }

  const incomingByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const incoming = incomingByTarget.get(edge.target);
    if (incoming) {
      incoming.push(edge.source);
    } else {
      incomingByTarget.set(edge.target, [edge.source]);
    }
  }

  const visited = new Set<string>();
  const upstreamIds = new Set<string>();
  const stack = [currentNodeId];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const incoming = incomingByTarget.get(nodeId);
    if (!incoming) {
      continue;
    }

    for (const sourceNodeId of incoming) {
      upstreamIds.add(sourceNodeId);
      if (!visited.has(sourceNodeId)) {
        stack.push(sourceNodeId);
      }
    }
  }

  return nodes.filter((node) => upstreamIds.has(node.id));
}

export function getUpstreamFields(input: {
  currentNodeId?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): UpstreamField[] {
  const upstreamNodes = getUpstreamNodes(input);

  return upstreamNodes.flatMap((node) => {
    const sourceNodeName = getNodeDisplayName(node);

    return getNodeOutputFields(node).map((field) => ({
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
