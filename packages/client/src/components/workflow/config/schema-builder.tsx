import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import type { WorkflowSchemaField } from "@rova/shared/graph/schema-codec";

export type SchemaField = WorkflowSchemaField & { id?: string };

type SchemaBuilderProps = {
  schema: SchemaField[];
  onChange: (schema: SchemaField[]) => void;
  disabled?: boolean;
  level?: number;
};

type ExpandedDetailsById = Record<string, boolean>;

const SCHEMA_FIELD_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "timestamp",
  "array",
  "object",
]);
const SCHEMA_ITEM_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "timestamp",
  "object",
]);

function isSchemaFieldType(value: string): value is SchemaField["type"] {
  return SCHEMA_FIELD_TYPES.has(value);
}

function isSchemaItemType(
  value: string
): value is NonNullable<SchemaField["itemType"]> {
  return SCHEMA_ITEM_TYPES.has(value);
}

function resetDependentFields(
  field: SchemaField,
  type: SchemaField["type"]
): SchemaField {
  const updated = { ...field };

  if (type !== "array") {
    updated.itemType = undefined;
  }
  if (type !== "object") {
    updated.fields = undefined;
  }
  if (type === "array" && !updated.itemType) {
    updated.itemType = "string";
  }
  if (type === "object" && !updated.fields) {
    updated.fields = [];
  }

  return updated;
}

export function SchemaBuilder({
  schema,
  onChange,
  disabled,
  level = 0,
}: SchemaBuilderProps) {
  const [expandedDetailsById, setExpandedDetailsById] =
    useState<ExpandedDetailsById>({});

  const getFieldId = (field: SchemaField, index: number) =>
    field.id || `field-${level}-${index}`;

  const isDetailsExpanded = (field: SchemaField, fieldId: string) => {
    const explicit = expandedDetailsById[fieldId];
    if (typeof explicit === "boolean") {
      return explicit;
    }

    if (field.type === "object") {
      return true;
    }

    if (field.type === "array" && field.itemType === "object") {
      return true;
    }

    return Boolean(field.description);
  };

  const setDetailsExpanded = (fieldId: string, expanded: boolean) => {
    setExpandedDetailsById((prev) => ({ ...prev, [fieldId]: expanded }));
  };

  const addField = () => {
    const nextId = nanoid();
    onChange([...schema, { id: nextId, name: "property", type: "string" }]);
    setDetailsExpanded(nextId, false);
  };

  const updateField = (index: number, updates: Partial<SchemaField>) => {
    const newSchema = [...schema];
    const originalField = newSchema[index];
    const nextField = { ...originalField, ...updates };

    // Reset dependent fields when type changes
    if (updates.type) {
      newSchema[index] = resetDependentFields(nextField, updates.type);
      const fieldId = getFieldId(newSchema[index], index);
      const shouldExpandForType =
        updates.type === "object" || updates.type === "array";

      if (shouldExpandForType) {
        setDetailsExpanded(fieldId, true);
      }
    } else {
      newSchema[index] = nextField;
    }

    onChange(newSchema);
  };

  const removeField = (index: number) => {
    const fieldId = getFieldId(schema[index], index);
    onChange(schema.filter((_, i) => i !== index));
    setExpandedDetailsById((prev) => {
      if (!(fieldId in prev)) {
        return prev;
      }

      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  };

  const updateNestedFields = (index: number, fields: SchemaField[]) => {
    const newSchema = [...schema];
    newSchema[index].fields = fields;
    onChange(newSchema);
  };

  const indentClass =
    level > 0 ? "ml-4 border-muted/70 border-l pl-3 md:ml-5 md:pl-4" : "";
  const showColumnHeader = schema.length > 0 && level === 0;
  const rowsContainerClass =
    level === 0 ? "divide-y rounded-md border bg-background px-2" : "space-y-2";

  return (
    <div className={`space-y-3 ${indentClass}`}>
      {showColumnHeader && (
        <div className="grid grid-cols-[minmax(0,1fr)_132px_auto_auto] gap-2 px-1 text-muted-foreground text-xs uppercase tracking-wide">
          <span>Property</span>
          <span>Type</span>
          <span className="sr-only">Details</span>
          <span className="sr-only">Delete</span>
        </div>
      )}
      <div className={rowsContainerClass}>
        {schema.map((field, index) => {
          const fieldId = getFieldId(field, index);
          const detailsExpanded = isDetailsExpanded(field, fieldId);

          return (
            <div className="space-y-2 py-2" key={fieldId}>
              <div className="grid grid-cols-[minmax(0,1fr)_132px_auto_auto] items-center gap-2">
                <Label
                  className="sr-only"
                  htmlFor={`field-name-${level}-${index}`}
                >
                  Property Name
                </Label>
                <Input
                  disabled={disabled}
                  id={`field-name-${level}-${index}`}
                  onChange={(e) => updateField(index, { name: e.target.value })}
                  placeholder="propertyName"
                  value={field.name}
                />

                <Label
                  className="sr-only"
                  htmlFor={`field-type-${level}-${index}`}
                >
                  Type
                </Label>
                <Select
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (isSchemaFieldType(value)) {
                      updateField(index, { type: value });
                    }
                  }}
                  value={field.type}
                >
                  <SelectTrigger
                    className="w-full"
                    id={`field-type-${level}-${index}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="string">String</SelectItem>
                    <SelectItem value="number">Number</SelectItem>
                    <SelectItem value="boolean">Boolean</SelectItem>
                    <SelectItem value="timestamp">Timestamp</SelectItem>
                    <SelectItem value="array">Array</SelectItem>
                    <SelectItem value="object">Object</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  aria-label={
                    detailsExpanded
                      ? "Hide field details"
                      : "Show field details"
                  }
                  disabled={disabled}
                  onClick={() => setDetailsExpanded(fieldId, !detailsExpanded)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  {detailsExpanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </Button>

                <div className="flex items-center justify-end">
                  <Button
                    aria-label="Delete property"
                    disabled={disabled}
                    onClick={() => removeField(index)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {detailsExpanded ? (
                <div className="space-y-3 border-muted/70 border-l pl-3">
                  {field.type === "array" && (
                    <div className="space-y-2">
                      <Label
                        className="ml-0.5"
                        htmlFor={`field-item-type-${level}-${index}`}
                      >
                        Array Item Type
                      </Label>
                      <Select
                        disabled={disabled}
                        onValueChange={(value) => {
                          if (isSchemaItemType(value)) {
                            updateField(index, { itemType: value });
                          }
                        }}
                        value={field.itemType || "string"}
                      >
                        <SelectTrigger
                          className="w-full"
                          id={`field-item-type-${level}-${index}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="string">String</SelectItem>
                          <SelectItem value="number">Number</SelectItem>
                          <SelectItem value="boolean">Boolean</SelectItem>
                          <SelectItem value="timestamp">Timestamp</SelectItem>
                          <SelectItem value="object">Object</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {field.type === "object" && (
                    <div className="mt-1">
                      <Label className="mb-2 ml-0.5 block text-muted-foreground text-xs uppercase tracking-wide">
                        Object Properties
                      </Label>
                      <SchemaBuilder
                        disabled={disabled}
                        level={level + 1}
                        onChange={(fields) => updateNestedFields(index, fields)}
                        schema={field.fields || []}
                      />
                    </div>
                  )}

                  {field.type === "array" && field.itemType === "object" && (
                    <div className="mt-1">
                      <Label className="mb-2 ml-0.5 block text-muted-foreground text-xs uppercase tracking-wide">
                        Array Item Properties
                      </Label>
                      <SchemaBuilder
                        disabled={disabled}
                        level={level + 1}
                        onChange={(fields) => updateNestedFields(index, fields)}
                        schema={field.fields || []}
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label
                      className="ml-0.5"
                      htmlFor={`field-desc-${level}-${index}`}
                    >
                      Description (optional)
                    </Label>
                    <Input
                      disabled={disabled}
                      id={`field-desc-${level}-${index}`}
                      onChange={(e) =>
                        updateField(index, { description: e.target.value })
                      }
                      placeholder="Description for the AI"
                      value={field.description || ""}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {schema.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No properties defined yet.
        </p>
      ) : null}

      <Button
        className="w-full justify-start"
        disabled={disabled}
        onClick={addField}
        type="button"
        variant="outline"
      >
        <Plus className="size-4" />
        Add Property
      </Button>
    </div>
  );
}
