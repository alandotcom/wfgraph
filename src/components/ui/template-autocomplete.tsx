import { useAtom } from "jotai";
import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  edgesAtom,
  nodesAtom,
  type WorkflowNode,
} from "@/client/lib/workflow-store";
import { findActionById } from "@/plugins";
import { cn } from "@/shared/utils";
import {
  parseWorkflowSchemaFieldsString,
  type WorkflowSchemaField,
} from "@/shared/workflow/schema-codec";

type TemplateAutocompleteProps = {
  isOpen: boolean;
  position: { top: number; left: number };
  onSelect: (template: string) => void;
  onClose: () => void;
  currentNodeId?: string;
  filter?: string;
  fieldType?: "duration" | "timestamp";
};

type AutocompleteField = {
  field: string;
  description: string;
  fieldType?: string;
  fieldFormat?: "timestamp";
};

function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
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
  schema: WorkflowSchemaField[],
  prefix = ""
): AutocompleteField[] => {
  const fields: AutocompleteField[] = [];

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
const getCommonFields = (node: WorkflowNode): AutocompleteField[] => {
  const actionType = readConfigString(node.data.config, "actionType");

  // Special handling for dynamic outputs (system actions and schema-based)
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

  // Check if the plugin defines output fields
  if (actionType) {
    const action = findActionById(actionType);
    if (action?.outputFields && action.outputFields.length > 0) {
      return action.outputFields.map((f) => ({
        field: f.field,
        description: f.description,
        fieldType: f.type,
        fieldFormat: f.format,
      }));
    }
  }

  // Trigger fields
  if (node.data.type === "trigger") {
    const triggerType = readConfigString(node.data.config, "triggerType");
    const webhookSchema = readConfigString(node.data.config, "webhookSchema");

    if (triggerType === "Webhook" && webhookSchema) {
      const schema = parseWorkflowSchemaFieldsString(webhookSchema);
      if (schema.length > 0) {
        return schemaToFields(schema);
      }
    }

    return [
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
  }

  return [{ field: "data", description: "Output data" }];
};

function isFieldCompatible(
  field: AutocompleteField,
  targetType: "duration" | "timestamp" | undefined
): boolean {
  if (!targetType) return true;
  if (!field.fieldType) return true;

  if (targetType === "duration") {
    return field.fieldType === "number";
  }

  if (targetType === "timestamp") {
    return field.fieldFormat === "timestamp";
  }

  return true;
}

export function TemplateAutocomplete({
  isOpen,
  position,
  onSelect,
  onClose,
  currentNodeId,
  filter = "",
  fieldType,
}: TemplateAutocompleteProps) {
  const [nodes] = useAtom(nodesAtom);
  const [edges] = useAtom(edgesAtom);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const upstreamNodes = useMemo(() => {
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
  }, [currentNodeId, edges, nodes]);

  const options = useMemo<
    Array<{
      type: "node" | "field";
      nodeId: string;
      nodeName: string;
      field?: string;
      description?: string;
      template: string;
    }>
  >(() => {
    const nextOptions: Array<{
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

      if (!fieldType) {
        nextOptions.push({
          type: "node",
          nodeId: node.id,
          nodeName,
          template: `{{@${node.id}:${nodeName}}}`,
        });
      }

      for (const field of fields) {
        if (!isFieldCompatible(field, fieldType)) continue;
        nextOptions.push({
          type: "field",
          nodeId: node.id,
          nodeName,
          field: field.field,
          description: field.description,
          template: `{{@${node.id}:${nodeName}.${field.field}}}`,
        });
      }
    }

    return nextOptions;
  }, [upstreamNodes, fieldType]);

  const filteredOptions = useMemo(() => {
    const trimmedFilter = filter.trim().toLowerCase();
    if (!trimmedFilter) {
      return options;
    }

    return options.filter(
      (opt) =>
        opt.nodeName.toLowerCase().includes(trimmedFilter) ||
        (opt.field && opt.field.toLowerCase().includes(trimmedFilter))
    );
  }, [filter, options]);

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
            onMouseDown={(event) => {
              // Select on pointer down so contentEditable inputs don't blur first.
              event.preventDefault();
              onSelect(option.template);
            }}
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
