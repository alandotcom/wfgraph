import { findRuntimeTrigger } from "@/lib/runtime-extensions";
import { findActionById } from "@/plugins/registry";
import type {
  ConditionFieldDefinition,
  ConditionFieldType,
} from "@/shared/workflow/conditions";
import {
  parseWorkflowSchemaFieldsString,
  type WorkflowSchemaField,
  type WorkflowSchemaFieldType,
} from "@/shared/workflow/schema-codec";
import type { WorkflowEdge, WorkflowNode } from "@/shared/workflow/types";

type NodeOutputField = {
  field: string;
  description: string;
  fieldType?: WorkflowSchemaFieldType;
  fieldFormat?: "timestamp";
  nullable?: boolean;
};

function dedupeNodeOutputFields(fields: NodeOutputField[]): NodeOutputField[] {
  const fieldsByPath = new Map<string, NodeOutputField>();

  for (const field of fields) {
    if (!fieldsByPath.has(field.field)) {
      fieldsByPath.set(field.field, field);
    }
  }

  return Array.from(fieldsByPath.values());
}

const DEFAULT_HTTP_OUTPUT_FIELDS: NodeOutputField[] = [
  { field: "data", description: "Response data", fieldType: "object" },
  {
    field: "status",
    description: "HTTP status code",
    fieldType: "number",
  },
];

const DEFAULT_DATABASE_OUTPUT_FIELDS: NodeOutputField[] = [
  { field: "rows", description: "Query result rows", fieldType: "array" },
  {
    field: "count",
    description: "Number of rows",
    fieldType: "number",
  },
];

const DEFAULT_TRIGGER_OUTPUT_FIELDS: NodeOutputField[] = [
  {
    field: "triggered",
    description: "Trigger status",
    fieldType: "boolean",
  },
  {
    field: "timestamp",
    description: "Trigger timestamp",
    fieldType: "timestamp",
  },
  { field: "input", description: "Input data", fieldType: "object" },
];

export type UpstreamField = NodeOutputField & {
  sourceNodeId: string;
  sourceNodeName: string;
};

export type ConditionSelectableField = ConditionFieldDefinition & {
  description: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeLabels: string[];
  nullable?: boolean;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function schemaToFields(
  schema: WorkflowSchemaField[],
  prefix = ""
): NodeOutputField[] {
  const fields: NodeOutputField[] = [];

  for (const schemaField of schema) {
    const fieldPath = prefix
      ? `${prefix}.${schemaField.name}`
      : schemaField.name;
    const typeLabel =
      schemaField.type === "array"
        ? `${schemaField.itemType}[]`
        : schemaField.type;
    const description = schemaField.description || typeLabel;

    fields.push({
      field: fieldPath,
      description,
      fieldType: schemaField.type,
      ...(schemaField.nullable ? { nullable: true } : {}),
    });

    if (
      schemaField.type === "object" &&
      schemaField.fields &&
      schemaField.fields.length > 0
    ) {
      fields.push(...schemaToFields(schemaField.fields, fieldPath));
    }

    if (
      schemaField.type === "array" &&
      schemaField.itemType === "object" &&
      schemaField.fields &&
      schemaField.fields.length > 0
    ) {
      const arrayItemPath = `${fieldPath}[0]`;
      fields.push(...schemaToFields(schemaField.fields, arrayItemPath));
    }
  }

  return fields;
}

function readOutputSchemaString(
  config: Record<string, unknown> | undefined,
  outputSchemaKey: string
): string | undefined {
  return readConfigString(config, outputSchemaKey);
}

function readSchemaFields(schemaString: string | undefined): NodeOutputField[] {
  if (!schemaString) {
    return [];
  }

  const schema = parseWorkflowSchemaFieldsString(schemaString);
  if (schema.length === 0) {
    return [];
  }

  return schemaToFields(schema);
}

function getHttpRequestOutputFields(
  config: Record<string, unknown> | undefined
): NodeOutputField[] {
  const outputSchemaFields = readSchemaFields(
    readOutputSchemaString(config, "httpOutputSchema")
  );

  if (outputSchemaFields.length === 0) {
    return DEFAULT_HTTP_OUTPUT_FIELDS;
  }

  return dedupeNodeOutputFields([
    ...DEFAULT_HTTP_OUTPUT_FIELDS,
    ...outputSchemaFields,
  ]);
}

function getDatabaseQueryOutputFields(
  config: Record<string, unknown> | undefined
): NodeOutputField[] {
  const outputSchemaFields = readSchemaFields(
    readOutputSchemaString(config, "dbOutputSchema")
  );

  if (outputSchemaFields.length > 0) {
    return outputSchemaFields;
  }

  return DEFAULT_DATABASE_OUTPUT_FIELDS;
}

function getTriggerOutputFields(node: WorkflowNode): NodeOutputField[] {
  const triggerType = readConfigString(node.data.config, "triggerType");

  // Webhook triggers: use webhookOutputSchema from node config
  if (triggerType === "Webhook") {
    const outputSchemaFields = readSchemaFields(
      readOutputSchemaString(node.data.config, "webhookOutputSchema")
    );

    if (outputSchemaFields.length === 0) {
      return DEFAULT_TRIGGER_OUTPUT_FIELDS;
    }

    return dedupeNodeOutputFields([
      ...DEFAULT_TRIGGER_OUTPUT_FIELDS,
      ...outputSchemaFields,
    ]);
  }

  // Custom/runtime triggers: use outputFields from trigger definition
  if (triggerType) {
    const runtimeTrigger = findRuntimeTrigger(triggerType);
    if (
      runtimeTrigger?.outputFields &&
      runtimeTrigger.outputFields.length > 0
    ) {
      const triggerFields: NodeOutputField[] = runtimeTrigger.outputFields.map(
        (field) => ({
          field: field.field,
          description: field.description,
          fieldType: field.type,
          fieldFormat: field.format,
          ...(field.nullable ? { nullable: true } : {}),
        })
      );

      return dedupeNodeOutputFields([
        ...DEFAULT_TRIGGER_OUTPUT_FIELDS,
        ...triggerFields,
      ]);
    }
  }

  return DEFAULT_TRIGGER_OUTPUT_FIELDS;
}

function getPluginActionOutputFields(actionType: string): NodeOutputField[] {
  const action = findActionById(actionType);
  if (!(action?.outputFields && action.outputFields.length > 0)) {
    return [];
  }

  return action.outputFields.map((field) => ({
    field: field.field,
    description: field.description,
    fieldType: field.type,
    fieldFormat: field.format,
    ...(field.nullable ? { nullable: true } : {}),
  }));
}

export function getNodeDisplayName(node: WorkflowNode): string {
  if (node.data.label) {
    return node.data.label;
  }

  if (node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      const action = findActionById(actionType);
      if (action?.label) {
        return action.label;
      }
    }

    return actionType || "HTTP Request";
  }

  if (node.data.type === "trigger") {
    const triggerType = readConfigString(node.data.config, "triggerType");
    return triggerType || "Webhook";
  }

  return "Node";
}

export function getNodeOutputFields(node: WorkflowNode): NodeOutputField[] {
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

  return [{ field: "data", description: "Output data" }];
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
  if (field.fieldType === "timestamp") {
    return "timestamp";
  }

  if (field.fieldFormat === "timestamp") {
    return "timestamp";
  }

  if (
    field.fieldType === "string" ||
    field.fieldType === "number" ||
    field.fieldType === "boolean"
  ) {
    return field.fieldType;
  }

  // Fields without an explicit type (common for custom action outputFields) default to string
  if (field.fieldType === undefined) {
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
    const path = field.field.trim();
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
    });
  }

  return Array.from(fieldsByPath.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
}
