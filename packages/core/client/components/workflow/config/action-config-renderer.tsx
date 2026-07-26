import { ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  isFieldGroup,
} from "@/plugins/registry";
import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  parseWorkflowSchemaFieldsString,
} from "@/shared/workflow/schema-codec";
import type { UpdateNodeConfig } from "./node-config-patch";
import { SchemaBuilder } from "./schema-builder";

type FieldProps = {
  field: ActionConfigFieldBase;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

function TemplateInputField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <TemplateBadgeInput
      disabled={disabled}
      id={field.key}
      onChange={onChange}
      placeholder={field.placeholder}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function TemplateTextareaField({
  field,
  value,
  onChange,
  disabled,
}: FieldProps) {
  return (
    <TemplateBadgeTextarea
      disabled={disabled}
      id={field.key}
      onChange={onChange}
      placeholder={field.placeholder}
      rows={field.rows || 4}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function TextInputField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <Input
      disabled={disabled}
      id={field.key}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function NumberInputField({ field, value, onChange, disabled }: FieldProps) {
  const displayValue =
    typeof value === "number" || typeof value === "string" ? `${value}` : "";

  return (
    <Input
      disabled={disabled}
      id={field.key}
      min={field.min}
      onChange={(event) => {
        const next = event.target.value.trim();
        if (!next) {
          onChange(undefined);
          return;
        }

        const parsed = Number.parseFloat(next);
        if (!Number.isFinite(parsed)) {
          return;
        }

        onChange(parsed);
      }}
      placeholder={field.placeholder}
      type="number"
      value={displayValue}
    />
  );
}

function SelectField({ field, value, onChange, disabled }: FieldProps) {
  if (!field.options) {
    return null;
  }

  return (
    <Select
      disabled={disabled}
      onValueChange={onChange}
      value={typeof value === "string" ? value : ""}
    >
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={field.placeholder} />
      </SelectTrigger>
      <SelectContent>
        {field.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type KeyValueEntry = { name: string; value: string };
type KeyValueEntryWithId = KeyValueEntry & { _id: string };

let kvIdCounter = 0;
function nextKvId(): string {
  return `kv-${++kvIdCounter}`;
}

function isKeyValueEntry(e: unknown): e is KeyValueEntry {
  if (typeof e !== "object" || e === null) {
    return false;
  }
  if (!("name" in e && "value" in e)) {
    return false;
  }
  return typeof e.name === "string" && typeof e.value === "string";
}

function parseKeyValueJson(raw: unknown): KeyValueEntry[] {
  if (typeof raw !== "string" || !raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(isKeyValueEntry);
    }
  } catch {
    // invalid JSON, return empty
  }
  return [];
}

function KeyValueField({ value, onChange, disabled }: FieldProps) {
  const [rows, setRows] = useState<KeyValueEntryWithId[]>(() =>
    parseKeyValueJson(value).map((e) => ({ ...e, _id: nextKvId() }))
  );

  function sync(next: KeyValueEntryWithId[]) {
    setRows(next);
    onChange(
      JSON.stringify(next.map(({ name, value: v }) => ({ name, value: v })))
    );
  }

  function addEntry() {
    sync([...rows, { name: "", value: "", _id: nextKvId() }]);
  }

  function removeEntry(id: string) {
    sync(rows.filter((r) => r._id !== id));
  }

  function updateEntry(
    id: string,
    field: "name" | "value",
    fieldValue: string
  ) {
    sync(rows.map((r) => (r._id === id ? { ...r, [field]: fieldValue } : r)));
  }

  return (
    <div className="space-y-2">
      {rows.map((entry) => (
        <div className="flex items-center gap-2" key={entry._id}>
          <Input
            className="flex-1"
            disabled={disabled}
            onChange={(e) => updateEntry(entry._id, "name", e.target.value)}
            placeholder="Name"
            value={entry.name}
          />
          <TemplateBadgeInput
            className="flex-1"
            disabled={disabled}
            onChange={(val) =>
              updateEntry(entry._id, "value", String(val ?? ""))
            }
            placeholder="Value"
            value={entry.value}
          />
          <Button
            className="h-8 w-8 shrink-0"
            disabled={disabled}
            onClick={() => removeEntry(entry._id)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        className="h-8"
        disabled={disabled}
        onClick={addEntry}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add
      </Button>
    </div>
  );
}

function SchemaBuilderField(props: FieldProps) {
  const schema =
    typeof props.value === "string"
      ? parseWorkflowSchemaFieldsString(props.value)
      : (parseWorkflowSchemaFieldsOrJsonSchema(props.value) ?? []);

  return (
    <SchemaBuilder
      disabled={props.disabled}
      onChange={(nextSchema) => props.onChange(nextSchema)}
      schema={schema}
    />
  );
}

const FIELD_RENDERERS: Record<
  ActionConfigFieldBase["type"],
  React.ComponentType<FieldProps>
> = {
  "template-input": TemplateInputField,
  "template-textarea": TemplateTextareaField,
  text: TextInputField,
  number: NumberInputField,
  select: SelectField,
  "schema-builder": SchemaBuilderField,
  "key-value": KeyValueField,
};

/**
 * Renders a single base field
 */
function renderField(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>,
  onUpdateConfig: UpdateNodeConfig,
  disabled?: boolean
) {
  // Check conditional rendering
  if (field.showWhen) {
    const dependentValue = config[field.showWhen.field];
    if (dependentValue !== field.showWhen.equals) {
      return null;
    }
  }

  const rawValue = config[field.key];
  const value = rawValue ?? field.defaultValue ?? "";
  const FieldRenderer = FIELD_RENDERERS[field.type];

  return (
    <div className="space-y-2" key={field.key}>
      {field.label && (
        <Label className="ml-1" htmlFor={field.key}>
          {field.label}
          {field.required && <span className="text-red-500">*</span>}
        </Label>
      )}
      <FieldRenderer
        disabled={disabled}
        field={field}
        onChange={(val) => onUpdateConfig({ [field.key]: val })}
        value={value}
      />
    </div>
  );
}

/**
 * Collapsible field group component
 */
function FieldGroup({
  label,
  fields,
  config,
  onUpdateConfig,
  disabled,
  defaultExpanded = false,
}: {
  label: string;
  fields: ActionConfigFieldBase[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled?: boolean;
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="space-y-2">
      <button
        className="ml-1 flex items-center gap-1 text-left"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <span className="font-medium text-sm">{label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${
            isExpanded ? "" : "-rotate-90"
          }`}
        />
      </button>
      {isExpanded && (
        <div className="ml-1 space-y-4 border-primary/50 border-l-2 py-2 pl-3">
          {fields.map((field) =>
            renderField(field, config, onUpdateConfig, disabled)
          )}
        </div>
      )}
    </div>
  );
}

type ActionConfigRendererProps = {
  fields: ActionConfigField[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled?: boolean;
};

/**
 * Renders action config fields declaratively
 * Converts ActionConfigField definitions into actual UI components
 */
export function ActionConfigRenderer({
  fields,
  config,
  onUpdateConfig,
  disabled,
}: ActionConfigRendererProps) {
  return (
    <>
      {fields.map((field) => {
        if (isFieldGroup(field)) {
          return (
            <FieldGroup
              config={config}
              defaultExpanded={field.defaultExpanded}
              disabled={disabled}
              fields={field.fields}
              key={`group-${field.label}`}
              label={field.label}
              onUpdateConfig={onUpdateConfig}
            />
          );
        }

        return renderField(field, config, onUpdateConfig, disabled);
      })}
    </>
  );
}
