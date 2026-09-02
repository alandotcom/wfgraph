import { ChevronDown, Plus, X } from "lucide-react";
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
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import { TemplateBadgeTextarea } from "#src/components/ui/template-badge-textarea";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  isFieldGroup,
} from "@wfgraph/shared/plugins/action-fields";
import {
  type KeyValueRow,
  readKeyValueRows,
} from "@wfgraph/shared/plugins/key-value-rows";
import { matchesShowWhen } from "@wfgraph/shared/types/show-when";
import type { UpdateNodeConfig } from "./node-config-patch";
import { ProviderFieldsField } from "./provider-fields-field";
import { ProviderSelectField } from "./provider-select-field";

type FieldProps = {
  field: ActionConfigFieldBase;
  value: unknown;
  /**
   * The node's whole config bag. A provider-backed field's question is
   * parameterised by its siblings and by the connection the node names, and both
   * live here: `action-config.tsx` writes `integrationId` beside the action's
   * own keys.
   */
  config: Record<string, unknown>;
  /**
   * What to show while the field is empty. Resolved by `renderField` rather
   * than read off `field`, because a field that falls back to a Connection
   * value shows that value instead of the catalog's example.
   */
  placeholder: string | undefined;
  onChange: (value: unknown) => void;
  disabled?: boolean | undefined;
};

function TemplateInputField({
  field,
  value,
  onChange,
  disabled,
  placeholder,
}: FieldProps) {
  return (
    <TemplateBadgeInput
      disabled={disabled}
      id={field.key}
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={placeholder}
      required={field.required}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function TemplateTextareaField({
  field,
  value,
  onChange,
  disabled,
  placeholder,
}: FieldProps) {
  return (
    <TemplateBadgeTextarea
      disabled={disabled}
      id={field.key}
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={placeholder}
      required={field.required}
      rows={field.rows || 4}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function TextInputField({
  field,
  value,
  onChange,
  disabled,
  placeholder,
}: FieldProps) {
  return (
    <Input
      disabled={disabled}
      id={field.key}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function NumberInputField({
  field,
  value,
  onChange,
  disabled,
  placeholder,
}: FieldProps) {
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
      placeholder={placeholder}
      type="number"
      value={displayValue}
    />
  );
}

function SelectField({
  field,
  value,
  onChange,
  disabled,
  placeholder,
}: FieldProps) {
  if (!field.options) {
    return null;
  }

  return (
    <Select
      disabled={disabled}
      items={field.options}
      onValueChange={onChange}
      value={typeof value === "string" ? value : ""}
    >
      <SelectTrigger className="w-full" id={field.key}>
        <SelectValue placeholder={placeholder} />
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

type KeyValueEntryWithId = KeyValueRow & { _id: string };

let kvIdCounter = 0;
function nextKvId(): string {
  return `kv-${++kvIdCounter}`;
}

function parseKeyValueJson(raw: unknown): KeyValueRow[] {
  if (typeof raw !== "string" || !raw) {
    return [];
  }
  return readKeyValueRows(raw) ?? [];
}

/**
 * The rows a `key-value` field stores, with a template control on each value.
 *
 * The name column stays plain text: it is the key of whatever the step builds,
 * and the systems that take one hold it to a short constrained alphabet, so a
 * reference resolved into it would name a key nobody could match. A value is
 * ordinary text, and the engine resolves each row's own before the step reads
 * them (`templateJsonFieldShapes`), so a reference here reaches the wire escaped
 * rather than breaking the JSON around it.
 */
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
            aria-label="Name"
            className="flex-1"
            disabled={disabled}
            onChange={(e) => updateEntry(entry._id, "name", e.target.value)}
            placeholder="Name"
            value={entry.name}
          />
          <TemplateBadgeInput
            ariaLabel="Value"
            className="flex-1"
            disabled={disabled}
            onChange={(next) => updateEntry(entry._id, "value", next)}
            placeholder="Value"
            value={entry.value}
          />
          <Button
            className="size-7 shrink-0"
            disabled={disabled}
            onClick={() => removeEntry(entry._id)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        disabled={disabled}
        onClick={addEntry}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="mr-1 size-3.5" />
        Add
      </Button>
    </div>
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
  "key-value": KeyValueField,
  "provider-select": ProviderSelectField,
  "provider-fields": ProviderFieldsField,
};

/**
 * Renders a single base field
 */
function renderField(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>,
  onUpdateConfig: UpdateNodeConfig,
  connectionDefaults: Record<string, string>,
  disabled?: boolean
) {
  // Check conditional rendering
  if (!matchesShowWhen(config, field.showWhen)) {
    return null;
  }

  const rawValue = config[field.key];
  const value = rawValue ?? field.defaultValue ?? "";
  // A field that falls back to a Connection value shows that value while it is
  // empty, so a builder reads what the run would actually send rather than a
  // generic example. Nothing is stored: this is the hint alone.
  const placeholder = field.connectionDefaultKey
    ? connectionDefaults[field.connectionDefaultKey] || field.placeholder
    : field.placeholder;
  const FieldRenderer = FIELD_RENDERERS[field.type];

  return (
    <div className="flex flex-col gap-2" key={field.key}>
      {field.label && (
        // The id is what names the template fields, whose editor is a
        // contenteditable div that `htmlFor` cannot reach. The asterisk is
        // decorative once `required` reaches the control as `aria-required`.
        <Label className="ml-1" htmlFor={field.key} id={`${field.key}-label`}>
          {field.label}
          {field.required && (
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          )}
        </Label>
      )}
      <FieldRenderer
        config={config}
        disabled={disabled}
        field={field}
        onChange={(val) => onUpdateConfig({ [field.key]: val })}
        placeholder={placeholder}
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
  connectionDefaults,
  disabled,
  defaultExpanded = false,
}: {
  label: string;
  fields: readonly ActionConfigFieldBase[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  connectionDefaults: Record<string, string>;
  disabled?: boolean | undefined;
  defaultExpanded?: boolean | undefined;
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
          className={`size-3.5 text-muted-foreground transition-transform duration-200 ${
            isExpanded ? "" : "-rotate-90"
          }`}
        />
      </button>
      {isExpanded && (
        <div className="ml-1 space-y-4 border-primary/50 border-l-2 py-2 pl-3">
          {fields.map((field) =>
            renderField(
              field,
              config,
              onUpdateConfig,
              connectionDefaults,
              disabled
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Stable, so a panel passing nothing does not re-render every field. */
const NO_CONNECTION_DEFAULTS: Record<string, string> = {};

type ActionConfigRendererProps = {
  fields: readonly ActionConfigField[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  /**
   * What the Connection this node names holds for each key a field declared as
   * its `connectionDefaultKey`. The panel above resolves it, because it already
   * reads the connection list to draw the picker.
   */
  connectionDefaults?: Record<string, string> | undefined;
  disabled?: boolean | undefined;
};

/**
 * Renders action config fields declaratively
 * Converts ActionConfigField definitions into actual UI components
 */
export function ActionConfigRenderer({
  fields,
  config,
  onUpdateConfig,
  connectionDefaults = NO_CONNECTION_DEFAULTS,
  disabled,
}: ActionConfigRendererProps) {
  return (
    <>
      {fields.map((field) => {
        if (isFieldGroup(field)) {
          return (
            <FieldGroup
              config={config}
              connectionDefaults={connectionDefaults}
              defaultExpanded={field.defaultExpanded}
              disabled={disabled}
              fields={field.fields}
              key={`group-${field.label}`}
              label={field.label}
              onUpdateConfig={onUpdateConfig}
            />
          );
        }

        return renderField(
          field,
          config,
          onUpdateConfig,
          connectionDefaults,
          disabled
        );
      })}
    </>
  );
}
