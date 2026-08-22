import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { TemplateBadgeInput } from "#src/components/form-fields/template-badge-input";
import { TemplateBadgeTextarea } from "#src/components/form-fields/template-badge-textarea";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  isFieldGroup,
} from "@wfgraph/shared/plugins/action-fields";
import { matchesShowWhen } from "@wfgraph/shared/types/show-when";
import type { UpdateNodeConfig } from "./node-config-patch";

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
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={field.placeholder}
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
}: FieldProps) {
  return (
    <TemplateBadgeTextarea
      disabled={disabled}
      id={field.key}
      labelledBy={field.label ? `${field.key}-label` : undefined}
      onChange={onChange}
      placeholder={field.placeholder}
      required={field.required}
      rows={field.rows || 4}
      value={typeof value === "string" ? value : ""}
    />
  );
}

function TextInputField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <TextInput
      isDisabled={disabled}
      isLabelHidden
      isRequired={field.required}
      label={field.label ?? field.key}
      onChange={onChange}
      placeholder={field.placeholder}
      value={typeof value === "string" ? value : ""}
      width="100%"
    />
  );
}

function NumberInputField({ field, value, onChange, disabled }: FieldProps) {
  const displayValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : null;

  return (
    <NumberInput
      hasClear
      isDisabled={disabled}
      isLabelHidden
      isRequired={field.required}
      label={field.label ?? field.key}
      min={field.min}
      onChange={(next) => onChange(next ?? undefined)}
      placeholder={field.placeholder}
      value={displayValue}
      width="100%"
    />
  );
}

function SelectField({ field, value, onChange, disabled }: FieldProps) {
  if (!field.options) {
    return null;
  }

  return (
    <Selector
      isDisabled={disabled}
      isLabelHidden
      isRequired={field.required}
      label={field.label ?? field.key}
      onChange={onChange}
      options={field.options.map((option) => ({
        value: option.value,
        label: option.label,
      }))}
      placement="below"
      placeholder={field.placeholder}
      value={typeof value === "string" ? value : ""}
      width="100%"
    />
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
    <VStack gap={2}>
      {rows.map((entry) => (
        <HStack align="end" gap={2} key={entry._id}>
          <TextInput
            isDisabled={disabled}
            isLabelHidden
            label="Name"
            onChange={(next) => updateEntry(entry._id, "name", next)}
            placeholder="Name"
            value={entry.name}
            width="100%"
            xstyle={styles.flexField}
          />
          <TemplateBadgeInput
            ariaLabel="Value"
            disabled={disabled}
            onChange={(val) => updateEntry(entry._id, "value", val ?? "")}
            placeholder="Value"
            value={entry.value}
            xstyle={styles.flexField}
          />
          <IconButton
            icon={<Icon icon={X} size="sm" />}
            isDisabled={disabled}
            label="Remove entry"
            onClick={() => removeEntry(entry._id)}
            size="sm"
            variant="ghost"
          />
        </HStack>
      ))}
      <Button
        icon={<Icon icon={Plus} size="sm" />}
        isDisabled={disabled}
        label="Add"
        onClick={addEntry}
        size="sm"
        variant="secondary"
      />
    </VStack>
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
  if (!matchesShowWhen(config, field.showWhen)) {
    return null;
  }

  const rawValue = config[field.key];
  const value = rawValue ?? field.defaultValue ?? "";
  const FieldRenderer = FIELD_RENDERERS[field.type];

  return (
    <VStack gap={2} key={field.key}>
      {field.label && (
        // The id is what names the template fields, whose editor is a
        // contenteditable div that `htmlFor` cannot reach. The asterisk is
        // decorative once `required` reaches the control as `aria-required`.
        <Text id={`${field.key}-label`} type="label">
          {field.label}
          {field.required && (
            <span aria-hidden="true" {...stylex.props(styles.required)}>
              *
            </span>
          )}
        </Text>
      )}
      <FieldRenderer
        disabled={disabled}
        field={field}
        onChange={(val) => onUpdateConfig({ [field.key]: val })}
        value={value}
      />
    </VStack>
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
  fields: readonly ActionConfigFieldBase[];
  config: Record<string, unknown>;
  onUpdateConfig: UpdateNodeConfig;
  disabled?: boolean;
  defaultExpanded?: boolean;
}) {
  return (
    <Collapsible defaultIsOpen={defaultExpanded} trigger={label}>
      <VStack gap={4} xstyle={styles.groupContent}>
        {fields.map((field) =>
          renderField(field, config, onUpdateConfig, disabled)
        )}
      </VStack>
    </Collapsible>
  );
}

type ActionConfigRendererProps = {
  fields: readonly ActionConfigField[];
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

const styles = stylex.create({
  flexField: {
    flex: 1,
    minWidth: 0,
  },
  required: {
    color: colorVars["--color-error"],
    marginInlineStart: spacingVars["--spacing-1"],
  },
  groupContent: {
    borderInlineStartColor: colorVars["--color-accent"],
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 2,
    marginInlineStart: spacingVars["--spacing-1"],
    paddingBlock: spacingVars["--spacing-2"],
    paddingInlineStart: spacingVars["--spacing-3"],
  },
});
