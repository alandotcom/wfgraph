import { Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useState } from "react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#src/components/ui/select";
import { whenChosen } from "#src/lib/select-choice";
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import { ConditionFieldCombobox } from "./condition-field-combobox";
import { ConfigSection } from "./config-section";
import { ConditionSummary } from "./condition-summary";
import {
  type ConditionFieldDefinition,
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  createDefaultConditionModel,
  createDefaultConditionRule,
  GROUP_LOGIC_OPTIONS,
  isNullCheckConditionRule,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  parseConditionModel,
  reconcileModelWithFields,
  serializeConditionModel,
  TIME_UNIT_OPTIONS,
  type TimeUnit,
} from "@wfgraph/shared/conditions/conditions";
import {
  appendOutputPathKey,
  displayTemplateText,
} from "@wfgraph/shared/graph/node-references";
import {
  applyOperatorValueToCondition,
  getOperatorOptionsByFieldType,
} from "./condition-builder-row-logic";

/**
 * What the row is written against, rather than where it is stored.
 *
 * Two callers build rules with it and neither keeps them the same way: a
 * Condition node stores a model and the CEL it compiles to on its own config, a
 * Wait Subscription stores the model alone and compiles it at park time, against
 * a payload that has not arrived yet. So the row takes its vocabulary and its
 * value as props and hands back both halves, leaving the storing to the caller.
 */
type ConditionBuilderRowProps = {
  label: string;
  /** See `ConfigSection`: what the Edit and Done buttons name. */
  editActionName?: string;
  /** See `ConfigSection`: only a row mounted in the panel column may pin. */
  stickyHeader?: boolean;
  description: string;
  /** The fields rules may be built from, already typed. */
  fields: ConditionSelectableField[];
  /** What to say when there are none. */
  emptyFieldsMessage: string;
  /** Serialized `ConditionModel`, empty when nothing is configured yet. */
  value: string;
  onChange: (next: { model: string; expression: string }) => void;
  /** Excluded from a value field's template autocomplete, being its own node. */
  currentNodeId?: string;
  /**
   * Whether the row opens in edit mode rather than in view mode. Read once, on
   * mount, for the caller that seeds a model with its own button: without it,
   * one click would produce a summary of a rule nobody has filled in yet.
   */
  defaultEditing?: boolean;
  disabled: boolean;
};

function isTimeUnitValue(value: string): value is TimeUnit {
  return TIME_UNIT_OPTIONS.some((option) => option.value === value);
}

function toLocalDateTimeInput(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const local = new Date(
    parsed.getTime() - parsed.getTimezoneOffset() * 60_000
  );
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(localDateTime: string): string {
  const parsed = new Date(localDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString();
}

function createInitialModel(field: ConditionFieldDefinition): ConditionModel {
  return createDefaultConditionModel(field, {
    groupId: nanoid(),
    conditionId: nanoid(),
  });
}

function createInitialRule(field: ConditionFieldDefinition): ConditionRule {
  return createDefaultConditionRule(field, nanoid());
}

function LogicToggle({
  value,
  onChange,
  disabled,
}: {
  value: "and" | "or";
  onChange: (value: "and" | "or") => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-full border bg-card p-0.5">
      {GROUP_LOGIC_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            className={`rounded-full px-3 py-1 font-medium text-xs transition-colors ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function enumOptionLabel(
  field: ConditionSelectableField | undefined,
  value: string
): string {
  return field?.enumLabels?.[value] ?? value;
}

function ConditionValueInput(input: {
  condition: ConditionRule;
  disabled: boolean;
  currentNodeId?: string;
  field?: ConditionSelectableField;
  onConditionChange: (condition: ConditionRule) => void;
}) {
  const { condition, disabled, currentNodeId, field, onConditionChange } =
    input;
  const enumValues = field?.enumValues;

  // Null-check operators need no value input
  if (isNullCheckConditionRule(condition)) {
    return null;
  }

  if (condition.fieldType === "timestamp") {
    if (isTimestampRelativeConditionRule(condition)) {
      return (
        <>
          <Input
            className="w-24"
            disabled={disabled}
            min={1}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              onConditionChange({
                ...condition,
                amount: Number.isNaN(parsed) ? 1 : Math.max(parsed, 1),
              });
            }}
            type="number"
            value={condition.amount}
          />
          <Select
            disabled={disabled}
            items={TIME_UNIT_OPTIONS}
            onValueChange={whenChosen((value) => {
              if (!isTimeUnitValue(value)) {
                return;
              }
              onConditionChange({
                ...condition,
                unit: value,
              });
            })}
            value={condition.unit}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_UNIT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      );
    }

    return (
      <Input
        disabled={disabled}
        onChange={(event) => {
          if (!isTimestampAbsoluteConditionRule(condition)) {
            return;
          }

          onConditionChange({
            ...condition,
            dateTime: toIsoDateTime(event.target.value),
          });
        }}
        type="datetime-local"
        value={
          isTimestampAbsoluteConditionRule(condition)
            ? toLocalDateTimeInput(condition.dateTime)
            : ""
        }
      />
    );
  }

  if (condition.fieldType === "string") {
    if (
      enumValues &&
      enumValues.length > 0 &&
      (condition.operator === "equals" || condition.operator === "not_equals")
    ) {
      return (
        <Select
          disabled={disabled}
          items={enumValues.map((value) => ({
            label: enumOptionLabel(field, value),
            value,
          }))}
          onValueChange={whenChosen((value) => {
            onConditionChange({ ...condition, value });
          })}
          // The field declares the whole of what this picker offers. A rule
          // still holding a value the field no longer names selects nothing,
          // which leaves the placeholder standing and the rule invalid until
          // one of the offered values is chosen.
          value={enumValues.includes(condition.value) ? condition.value : null}
        >
          <SelectTrigger className="min-w-[240px]">
            <SelectValue placeholder="Select value" />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {enumOptionLabel(field, opt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    return (
      <TemplateBadgeInput
        className="min-w-[240px]"
        currentNodeId={currentNodeId}
        disabled={disabled}
        onChange={(value) => {
          onConditionChange({
            ...condition,
            value,
          });
        }}
        placeholder="value"
        value={condition.value}
      />
    );
  }

  if (condition.fieldType === "number") {
    return (
      <Input
        disabled={disabled}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          onConditionChange({
            ...condition,
            value: Number.isNaN(parsed) ? 0 : parsed,
          });
        }}
        placeholder="0"
        type="number"
        value={String(condition.value)}
      />
    );
  }

  return null;
}

export function ConditionBuilderRow({
  label,
  editActionName,
  stickyHeader,
  description,
  fields: availableFields,
  emptyFieldsMessage,
  value: storedValue,
  onChange,
  currentNodeId,
  defaultEditing = false,
  disabled,
}: ConditionBuilderRowProps) {
  const seedField = availableFields[0] ?? null;
  // The mode is this row's own, and it belongs to no workflow: a fresh open
  // starts where `defaultEditing` says, whatever the last one was left in.
  const [editing, setEditing] = useState(defaultEditing);

  const modelValue = storedValue.trim();
  const modelParseResult = parseConditionModel(modelValue);
  const storedModel = modelParseResult.valid ? modelParseResult.model : null;

  const fieldByPath = new Map(
    availableFields.map((field) => [field.path, field])
  );

  const persistModel = useCallback(
    (model: ConditionModel) => {
      // The model and the CEL it compiles to are one fact, so both go to the
      // caller together. A model that fails to compile is still handed over,
      // with an empty expression beside it: a half-built rule is a state the
      // builder is in, not an edit to refuse.
      const compiled = compileConditionModel(model);
      onChange({
        model: serializeConditionModel(model),
        expression: compiled.valid ? compiled.expression : "",
      });
    },
    [onChange]
  );

  const addConditionModel = useCallback(() => {
    if (!seedField) {
      return;
    }

    persistModel(createInitialModel(seedField));
  }, [persistModel, seedField]);

  // Rules are reconciled against the fields available now, on the way to being
  // rendered, and nothing is written until the user next touches the row --
  // that is the moment the reconciled shape becomes their edit rather than a
  // change they never made.
  const parsedModel = storedModel
    ? reconcileModelWithFields(storedModel, fieldByPath)
    : null;

  // Derived in render rather than remembered from the last write, so a model
  // that arrives already broken says so on the first paint.
  const compiled = parsedModel ? compileConditionModel(parsedModel) : null;

  const updateGroup = (
    groupId: string,
    updater: (
      group: ConditionModel["groups"][number]
    ) => ConditionModel["groups"][number]
  ) => {
    if (!parsedModel) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: parsedModel.groups.map((group) =>
        group.id === groupId ? updater(group) : group
      ),
    });
  };

  const updateCondition = (
    groupId: string,
    conditionId: string,
    updater: (condition: ConditionRule) => ConditionRule
  ) => {
    updateGroup(groupId, (group) => ({
      ...group,
      conditions: group.conditions.map((condition) =>
        condition.id === conditionId ? updater(condition) : condition
      ),
    }));
  };

  const addConditionToGroup = (groupId: string) => {
    if (!(parsedModel && seedField)) {
      return;
    }

    updateGroup(groupId, (group) => ({
      ...group,
      conditions: [...group.conditions, createInitialRule(seedField)],
    }));
  };

  const removeConditionFromGroup = (groupId: string, conditionId: string) => {
    if (!parsedModel) {
      return;
    }

    updateGroup(groupId, (group) => {
      if (group.conditions.length <= 1) {
        return group;
      }

      return {
        ...group,
        conditions: group.conditions.filter(
          (condition) => condition.id !== conditionId
        ),
      };
    });
  };

  const addGroup = () => {
    if (!(parsedModel && seedField)) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: [
        ...parsedModel.groups,
        {
          id: nanoid(),
          logic: "and",
          conditions: [createInitialRule(seedField)],
        },
      ],
    });
  };

  const removeGroup = (groupId: string) => {
    if (!parsedModel || parsedModel.groups.length <= 1) {
      return;
    }

    persistModel({
      ...parsedModel,
      groups: parsedModel.groups.filter((group) => group.id !== groupId),
    });
  };

  // The section is what holds the two modes, and it offers Edit only once
  // there is a model to edit: a row with nothing configured has no view to
  // show, so its one button both seeds a model and opens the editor.
  const editable = !disabled && parsedModel !== null;

  return (
    <ConfigSection
      editable={editable}
      editActionName={editActionName}
      editing={editing}
      help={<p>{description}</p>}
      label={label}
      onEditingChange={setEditing}
      stickyHeader={stickyHeader}
      view={
        parsedModel ? (
          <ConditionSummary fields={availableFields} model={parsedModel} />
        ) : (
          <div className="space-y-2">
            {availableFields.length > 0 ? (
              <Button
                disabled={disabled}
                onClick={() => {
                  addConditionModel();
                  setEditing(true);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Configure condition
              </Button>
            ) : (
              <p className="text-muted-foreground text-xs">
                {emptyFieldsMessage}
              </p>
            )}
            {modelValue && !modelParseResult.valid && (
              <p className="text-destructive text-xs">
                {modelParseResult.error}
              </p>
            )}
          </div>
        )
      }
    >
      {parsedModel ? (
        <>
          {parsedModel.groups.map((group, groupIndex) => (
            <div key={group.id}>
              {/* The joiner sits on the divider between two groups rather than
                  floating over it, which is what lets a group be a gutter rule
                  instead of a card. */}
              {groupIndex > 0 && (
                <div className="flex items-center gap-2 py-2">
                  <span className="h-px flex-1 bg-border" />
                  <LogicToggle
                    disabled={disabled}
                    onChange={(value) => {
                      persistModel({
                        ...parsedModel,
                        groupLogic: value,
                      });
                    }}
                    value={parsedModel.groupLogic}
                  />
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-xs">
                    {groupIndex + 1}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {group.conditions.length}{" "}
                    {group.conditions.length === 1 ? "condition" : "conditions"}
                  </span>
                </div>
                <Button
                  disabled={disabled || parsedModel.groups.length <= 1}
                  onClick={() => removeGroup(group.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>

              {/* The gutter: a left rule with the rows indented behind it, in
                  place of the bordered card these used to sit in. */}
              <div className="mt-1 ml-2.5 space-y-2 border-l pl-3">
                {group.conditions.map((condition, conditionIndex) => {
                  const selectedFieldDef = fieldByPath.get(condition.field);
                  // The picker deals in whole paths; the rule stores the record
                  // and its key apart. This is the one conversion between them,
                  // so a rule reached by typing a key reads back as the row that
                  // names it.
                  const namedPath = condition.recordKey
                    ? appendOutputPathKey(condition.field, condition.recordKey)
                    : condition.field;
                  // A key the graph names has a row of its own; one nobody names
                  // leaves the record itself selected, with the key beside it.
                  const pickedPath = fieldByPath.has(namedPath)
                    ? namedPath
                    : condition.field;
                  const operatorOptions = getOperatorOptionsByFieldType(
                    condition.fieldType,
                    selectedFieldDef?.nullable ||
                      condition.recordKey !== undefined
                  );
                  const canDeleteCondition = group.conditions.length > 1;

                  return (
                    <div key={condition.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <ConditionFieldCombobox
                          disabled={disabled || availableFields.length === 0}
                          fields={availableFields}
                          onValueChange={(nextField) => {
                            if (nextField.path === pickedPath) {
                              return;
                            }

                            // A row for a key the graph names is a shortcut for
                            // the record plus that key, and it carries the split
                            // so the rule it writes is the one typing the key
                            // would have written.
                            const chosen: ConditionFieldDefinition =
                              nextField.recordPath
                                ? {
                                    ...nextField,
                                    path: nextField.recordPath,
                                    openRecord: true,
                                  }
                                : nextField;

                            updateCondition(
                              group.id,
                              condition.id,
                              (existing) => {
                                const seeded = createDefaultConditionRule(
                                  chosen,
                                  existing.id
                                );
                                return nextField.recordKey
                                  ? {
                                      ...seeded,
                                      recordKey: nextField.recordKey,
                                    }
                                  : seeded;
                              }
                            );
                          }}
                          valuePath={pickedPath}
                        />

                        {condition.recordKey !== undefined && (
                          <Input
                            aria-label="Key"
                            className="w-36"
                            disabled={disabled}
                            onChange={(event) =>
                              updateCondition(
                                group.id,
                                condition.id,
                                (existing) => ({
                                  ...existing,
                                  // The key alone: every key of a record carries
                                  // the record's value type, so the operator and
                                  // the value the builder already chose still
                                  // stand. Rebuilding the rule here would throw
                                  // them away on every keystroke.
                                  recordKey: event.target.value,
                                })
                              )
                            }
                            placeholder="key"
                            value={condition.recordKey}
                          />
                        )}

                        <Select
                          disabled={disabled}
                          items={operatorOptions}
                          onValueChange={whenChosen((operatorValue) => {
                            const nextCondition = applyOperatorValueToCondition(
                              condition,
                              operatorValue
                            );
                            if (!nextCondition) {
                              return;
                            }

                            updateCondition(
                              group.id,
                              condition.id,
                              () => nextCondition
                            );
                          })}
                          value={condition.operator}
                        >
                          <SelectTrigger className="min-w-[190px]">
                            <SelectValue placeholder="Select operator" />
                          </SelectTrigger>
                          <SelectContent>
                            {operatorOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <ConditionValueInput
                          condition={condition}
                          currentNodeId={currentNodeId}
                          disabled={disabled}
                          field={selectedFieldDef}
                          onConditionChange={(nextCondition) => {
                            updateCondition(
                              group.id,
                              condition.id,
                              () => nextCondition
                            );
                          }}
                        />

                        <Button
                          disabled={disabled || !canDeleteCondition}
                          onClick={() =>
                            removeConditionFromGroup(group.id, condition.id)
                          }
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>

                      {conditionIndex < group.conditions.length - 1 && (
                        <div className="pt-2">
                          <LogicToggle
                            disabled={disabled}
                            onChange={(value) => {
                              updateGroup(group.id, (existing) => ({
                                ...existing,
                                logic: value,
                              }));
                            }}
                            value={group.logic}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

                <Button
                  disabled={disabled || !seedField}
                  onClick={() => addConditionToGroup(group.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Plus className="size-4" />
                  Add condition
                </Button>
              </div>
            </div>
          ))}

          <div className="flex justify-center pt-1">
            <Button
              disabled={disabled || !seedField}
              onClick={addGroup}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-4" />
              Add group
            </Button>
          </div>

          {compiled?.valid === false && (
            <p className="text-destructive text-xs">{compiled.error}</p>
          )}
          {compiled?.valid && (
            <p className="text-muted-foreground text-xs">
              Compiled CEL: {displayTemplateText(compiled.expression)}
            </p>
          )}
        </>
      ) : null}
    </ConfigSection>
  );
}
