import { useAtom } from "jotai";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  edgesAtom,
  nodesAtom,
  type WorkflowNode,
} from "@/client/lib/workflow-store";
import { findActionById } from "@/plugins";
import { cn } from "@/shared/utils";

type TemplateAutocompleteProps = {
  isOpen: boolean;
  position: { top: number; left: number };
  onSelect: (template: string) => void;
  onClose: () => void;
  currentNodeId?: string;
  filter?: string;
};

type SchemaField = {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  itemType?: "string" | "number" | "boolean" | "object";
  fields?: SchemaField[];
  format?: "timestamp";
  description?: string;
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaFieldType(value: unknown): value is SchemaField["type"] {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "array" ||
    value === "object"
  );
}

function isSchemaItemType(value: unknown): value is NonNullable<SchemaField["itemType"]> {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "object"
  );
}

function parseSchemaField(value: unknown): SchemaField | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    return null;
  }

  const type = isSchemaFieldType(value.type) ? value.type : "string";
  const description =
    typeof value.description === "string" ? value.description : undefined;
  const format = value.format === "timestamp" ? "timestamp" : undefined;

  if (type === "object") {
    const fields = Array.isArray(value.fields)
      ? value.fields.flatMap((field) => {
          const parsedField = parseSchemaField(field);
          return parsedField ? [parsedField] : [];
        })
      : [];

    return {
      name,
      type,
      fields,
      description,
    };
  }

  if (type === "array") {
    const itemType = isSchemaItemType(value.itemType) ? value.itemType : "string";
    const fields =
      itemType === "object" && Array.isArray(value.fields)
        ? value.fields.flatMap((field) => {
            const parsedField = parseSchemaField(field);
            return parsedField ? [parsedField] : [];
          })
        : undefined;

    return {
      name,
      type,
      itemType,
      fields,
      format: itemType === "string" ? format : undefined,
      description,
    };
  }

  return {
    name,
    type,
    format: type === "string" ? format : undefined,
    description,
  };
}

function parseSchemaFields(value: string | undefined): SchemaField[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((field) => {
      const parsedField = parseSchemaField(field);
      return parsedField ? [parsedField] : [];
    });
  } catch {
    return [];
  }
}

// Helper to get a display name for a node
const getNodeDisplayName = (node: WorkflowNode): string => {
  if (node.data.label) {
    return node.data.label;
  }

  if (node.data.type === "action") {
    const actionType = readConfigString(node.data.config, "actionType");
    if (actionType) {
      // Look up human-readable label from plugin registry
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
};

// Convert schema fields to field descriptions
const schemaToFields = (
  schema: SchemaField[],
  prefix = ""
): Array<{ field: string; description: string }> => {
  const fields: Array<{ field: string; description: string }> = [];

  for (const schemaField of schema) {
    const fieldPath = prefix
      ? `${prefix}.${schemaField.name}`
      : schemaField.name;
    const typeLabel =
      schemaField.type === "array"
        ? `${schemaField.itemType}[]`
        : schemaField.type;
    const description = schemaField.description || typeLabel;

    fields.push({ field: fieldPath, description });

    // Add nested fields for objects
    if (
      schemaField.type === "object" &&
      schemaField.fields &&
      schemaField.fields.length > 0
    ) {
      fields.push(...schemaToFields(schemaField.fields, fieldPath));
    }

    // Add nested fields for array items that are objects
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
};

// Get common fields based on node action type
const getCommonFields = (node: WorkflowNode) => {
  const actionType = readConfigString(node.data.config, "actionType");

  // Special handling for dynamic outputs (system actions and schema-based)
  if (actionType === "HTTP Request") {
    return [
      { field: "data", description: "Response data" },
      { field: "status", description: "HTTP status code" },
    ];
  }

  if (actionType === "Database Query") {
    const dbSchema = readConfigString(node.data.config, "dbSchema");
    if (dbSchema) {
      const schema = parseSchemaFields(dbSchema);
      if (schema.length > 0) {
        return schemaToFields(schema);
      }
    }
    return [
      { field: "rows", description: "Query result rows" },
      { field: "count", description: "Number of rows" },
    ];
  }

  // Check if the plugin defines output fields
  if (actionType) {
    const action = findActionById(actionType);
    if (action?.outputFields && action.outputFields.length > 0) {
      return action.outputFields;
    }
  }

  // Trigger fields
  if (node.data.type === "trigger") {
    const triggerType = readConfigString(node.data.config, "triggerType");
    const webhookSchema = readConfigString(node.data.config, "webhookSchema");

    if (triggerType === "Webhook" && webhookSchema) {
      const schema = parseSchemaFields(webhookSchema);
      if (schema.length > 0) {
        return schemaToFields(schema);
      }
    }

    return [
      { field: "triggered", description: "Trigger status" },
      { field: "timestamp", description: "Trigger timestamp" },
      { field: "input", description: "Input data" },
    ];
  }

  return [{ field: "data", description: "Output data" }];
};

export function TemplateAutocomplete({
  isOpen,
  position,
  onSelect,
  onClose,
  currentNodeId,
  filter = "",
}: TemplateAutocompleteProps) {
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Find all nodes that come before the current node
  const getUpstreamNodes = () => {
    if (!currentNodeId) {
      return [];
    }

    const visited = new Set<string>();
    const upstream: string[] = [];

    const traverse = (nodeId: string) => {
      if (visited.has(nodeId)) {
        return;
      }
      visited.add(nodeId);

      const incomingEdges = edges.filter((edge) => edge.target === nodeId);
      for (const edge of incomingEdges) {
        upstream.push(edge.source);
        traverse(edge.source);
      }
    };

    traverse(currentNodeId);

    return nodes.filter((node) => upstream.includes(node.id));
  };

  const upstreamNodes = getUpstreamNodes();

  // Build list of all available options (nodes + their fields)
  const options: Array<{
    type: "node" | "field";
    nodeId: string;
    nodeName: string;
    field?: string;
    description?: string;
    template: string;
  }> = [];

  for (const node of upstreamNodes) {
    const nodeName = getNodeDisplayName(node);
    const fields = getCommonFields(node);

    // Add node itself
    options.push({
      type: "node",
      nodeId: node.id,
      nodeName,
      template: `{{@${node.id}:${nodeName}}}`,
    });

    // Add fields
    for (const field of fields) {
      options.push({
        type: "field",
        nodeId: node.id,
        nodeName,
        field: field.field,
        description: field.description,
        template: `{{@${node.id}:${nodeName}.${field.field}}}`,
      });
    }
  }

  // Filter options based on search term
  const filteredOptions = filter
    ? options.filter(
        (opt) =>
          opt.nodeName.toLowerCase().includes(filter.toLowerCase()) ||
          (opt.field && opt.field.toLowerCase().includes(filter.toLowerCase()))
      )
    : options;
  const selectedOptionIndex =
    filteredOptions.length === 0
      ? 0
      : Math.min(selectedIndex, filteredOptions.length - 1);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredOptions[selectedOptionIndex]) {
            onSelect(filteredOptions[selectedOptionIndex].template);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredOptions, selectedOptionIndex, onSelect, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    if (menuRef.current) {
      const selectedElement = menuRef.current.children.item(selectedOptionIndex);
      if (selectedElement instanceof HTMLElement) {
        selectedElement.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedOptionIndex]);

  if (
    !isOpen ||
    filteredOptions.length === 0 ||
    typeof document === "undefined"
  ) {
    return null;
  }

  // Ensure position is within viewport
  const adjustedPosition = {
    top: Math.min(position.top, window.innerHeight - 300), // Keep 300px from bottom
    left: Math.min(position.left, window.innerWidth - 320), // Keep menu (320px wide) within viewport
  };

  const menuContent = (
    <div
      className="fixed z-[9999] w-80 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      ref={menuRef}
      style={{
        top: `${adjustedPosition.top}px`,
        left: `${adjustedPosition.left}px`,
      }}
    >
      <div className="max-h-60 overflow-y-auto">
        {filteredOptions.map((option, index) => (
          <div
            className={cn(
              "flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm transition-colors",
              index === selectedOptionIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50"
            )}
            key={`${option.nodeId}-${option.field || "root"}`}
            onClick={() => onSelect(option.template)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <div className="flex-1">
              <div className="font-medium">
                {option.type === "node" ? (
                  option.nodeName
                ) : (
                  <>
                    <span className="text-muted-foreground">
                      {option.nodeName}.
                    </span>
                    {option.field}
                  </>
                )}
              </div>
              {option.description && (
                <div className="text-muted-foreground text-xs">
                  {option.description}
                </div>
              )}
            </div>
            {index === selectedOptionIndex && <Check className="h-4 w-4" />}
          </div>
        ))}
      </div>
    </div>
  );

  // Use portal to render at document root to avoid clipping issues
  return createPortal(menuContent, document.body);
}
