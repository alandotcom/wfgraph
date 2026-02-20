import { findActionById } from "@/plugins";
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

export type UpstreamField = NodeOutputField & {
  sourceNodeId: string;
  sourceNodeName: string;
};

export type ConditionSelectableField = ConditionFieldDefinition & {
  description: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeLabels: string[];
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
      fieldFormat: schemaField.format,
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
    return [
      { field: "data", description: "Response data", fieldType: "object" },
      {
        field: "status",
        description: "HTTP status code",
        fieldType: "number",
      },
    ];
  }

  if (actionType === "Database Query") {
    const dbSchema = readConfigString(node.data.config, "dbSchema");
    if (dbSchema) {
      const schema = parseWorkflowSchemaFieldsString(dbSchema);
      if (schema.length > 0) {
        return schemaToFields(schema);
      }
    }

    return [
      { field: "rows", description: "Query result rows", fieldType: "array" },
      {
        field: "count",
        description: "Number of rows",
        fieldType: "number",
      },
    ];
  }

  if (actionType) {
    const action = findActionById(actionType);
    if (action?.outputFields && action.outputFields.length > 0) {
      return action.outputFields.map((field) => ({
        field: field.field,
        description: field.description,
        fieldType: field.type,
        fieldFormat: field.format,
      }));
    }
  }

  if (node.data.type === "trigger") {
    const triggerType = readConfigString(node.data.config, "triggerType");
    const webhookSchema = readConfigString(node.data.config, "webhookSchema");
    const fallbackTriggerFields: NodeOutputField[] = [
      {
        field: "triggered",
        description: "Trigger status",
        fieldType: "boolean",
      },
      {
        field: "timestamp",
        description: "Trigger timestamp",
        fieldType: "string",
        fieldFormat: "timestamp",
      },
      { field: "input", description: "Input data", fieldType: "object" },
    ];

    if (triggerType === "Webhook" && webhookSchema) {
      const schema = parseWorkflowSchemaFieldsString(webhookSchema);
      if (schema.length > 0) {
        return dedupeNodeOutputFields([
          ...fallbackTriggerFields,
          ...schemaToFields(schema),
        ]);
      }
    }

    return fallbackTriggerFields;
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
    });
  }

  return Array.from(fieldsByPath.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path)
  );
}
