import { Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useMemo } from "react";
import { Button } from "#src/components/ui/button";
import { Input } from "#src/components/ui/input";
import { Label } from "#src/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  whenChosen,
} from "#src/components/ui/select";
import { TemplateBadgeInput } from "#src/components/ui/template-badge-input";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import {
  BOOLEAN_OPERATOR_OPTIONS,
  type ConditionFieldDefinition,
  type ConditionFieldType,
  type ConditionModel,
  type ConditionRule,
  compileConditionModel,
  createDefaultConditionModel,
  createDefaultConditionRule,
  GROUP_LOGIC_OPTIONS,
  isNullCheckConditionRule,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  NULLCHECK_OPERATOR_OPTIONS,
  NUMBER_OPERATOR_OPTIONS,
  parseConditionModel,
  reconcileModelWithFields,
  STRING_OPERATOR_OPTIONS,
  serializeConditionModel,
  TIME_UNIT_OPTIONS,
  TIMESTAMP_OPERATOR_OPTIONS,
  type TimestampAbsoluteOperator,
  type TimestampRelativeOperator,
  type TimeUnit,
} from "@rova/shared/conditions/conditions";

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
  disabled: boolean;
};

function isTimestampRelativeOperatorValue(
  value: string
): value is TimestampRelativeOperator {
  return (
    value === "within_next" ||
    value === "more_than_from_now" ||
    value === "less_than_ago" ||
    value === "more_than_ago"
  );
}

function isTimestampAbsoluteOperatorValue(
  value: string
): value is TimestampAbsoluteOperator {
  return value === "before" || value === "after";
}

function isStringOperatorValue(
  value: string
): value is "equals" | "not_equals" | "contains" {
  return value === "equals" || value === "not_equals" || value === "contains";
}

function isNumberOperatorValue(
  value: string
): value is
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal" {
  return (
    value === "equals" ||
    value === "not_equals" ||
    value === "greater_than" ||
    value === "greater_or_equal" ||
    value === "less_than" ||
    value === "less_or_equal"
  );
}

function isBooleanOperatorValue(
  value: string
): value is "is_true" | "is_false" {
  return value === "is_true" || value === "is_false";
}

function isTimeUnitValue(value: string): value is TimeUnit {
  return TIME_UNIT_OPTIONS.some((option) => option.value === value);
}

function getOperatorOptionsByFieldType(
  fieldType: ConditionFieldType,
  nullable?: boolean
) {
  const nullOpts = nullable ? NULLCHECK_OPERATOR_OPTIONS : [];

  if (fieldType === "timestamp") {
    return [...TIMESTAMP_OPERATOR_OPTIONS, ...nullOpts];
  }

  if (fieldType === "string") {
    return [...STRING_OPERATOR_OPTIONS, ...nullOpts];
  }

  if (fieldType === "number") {
    return [...NUMBER_OPERATOR_OPTIONS, ...nullOpts];
  }

  return [...BOOLEAN_OPERATOR_OPTIONS, ...nullOpts];
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

function buildTimestampOperatorRule(input: {
  condition: Extract<ConditionRule, { fieldType: "timestamp" }>;
  operatorValue: string;
}): Extract<ConditionRule, { fieldType: "timestamp" }> | null {
  const { condition, operatorValue } = input;

  if (isTimestampRelativeOperatorValue(operatorValue)) {
    return {
      id: condition.id,
      field: condition.field,
      fieldType: "timestamp",
      operator: operatorValue,
      amount: isTimestampRelativeConditionRule(condition)
        ? condition.amount
        : 1,
      unit: isTimestampRelativeConditionRule(condition)
        ? condition.unit
        : "days",
    };
  }

  if (isTimestampAbsoluteOperatorValue(operatorValue)) {
    return {
      id: condition.id,
      field: condition.field,
      fieldType: "timestamp",
      operator: operatorValue,
      dateTime: isTimestampAbsoluteConditionRule(condition)
        ? condition.dateTime
        : new Date().toISOString(),
    };
  }

  return null;
}

function isNullCheckOperatorValue(
  value: string
): value is "is_set" | "is_not_set" {
  return value === "is_set" || value === "is_not_set";
}

function applyOperatorValueToCondition(
  condition: ConditionRule,
  operatorValue: string
): ConditionRule | null {
  const base = { id: condition.id, field: condition.field };

  if (isNullCheckOperatorValue(operatorValue)) {
    return {
      ...base,
      fieldType: condition.fieldType,
      operator: operatorValue,
    };
  }

  if (condition.fieldType === "timestamp") {
    // Switching from null-check back to timestamp — supply defaults
    const tsCondition: Extract<ConditionRule, { fieldType: "timestamp" }> =
      isNullCheckConditionRule(condition)
        ? {
            ...base,
            fieldType: "timestamp" as const,
            operator: "within_next" as const,
            amount: 1,
            unit: "days" as const,
          }
        : condition;
    return buildTimestampOperatorRule({
      condition: tsCondition,
      operatorValue,
    });
  }

  if (condition.fieldType === "string") {
    if (!isStringOperatorValue(operatorValue)) {
      return null;
    }
    const value =
      !isNullCheckConditionRule(condition) && "value" in condition
        ? condition.value
        : "";
    return { ...base, fieldType: "string", operator: operatorValue, value };
  }

  if (condition.fieldType === "number") {
    if (!isNumberOperatorValue(operatorValue)) {
      return null;
    }
    const value =
      !isNullCheckConditionRule(condition) && "value" in condition
        ? condition.value
        : 0;
    return { ...base, fieldType: "number", operator: operatorValue, value };
  }

  if (!isBooleanOperatorValue(operatorValue)) {
    return null;
  }

  return { ...base, fieldType: "boolean", operator: operatorValue };
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

function ConditionValueInput(input: {
  condition: ConditionRule;
  disabled: boolean;
  currentNodeId?: string;
  enumValues?: string[];
  onConditionChange: (condition: ConditionRule) => void;
}) {
  const { condition, disabled, currentNodeId, enumValues, onConditionChange } =
    input;

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
                {opt}
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
  description,
  fields: availableFields,
  emptyFieldsMessage,
  value: storedValue,
  onChange,
  currentNodeId,
  disabled,
}: ConditionBuilderRowProps) {
  const seedField = availableFields[0] ?? null;

  const fieldByPath = useMemo(
    () => new Map(availableFields.map((field) => [field.path, field])),
    [availableFields]
  );
  const availableFieldsBySource = useMemo(() => {
    const grouped = new Map<string, typeof availableFields>();

    for (const field of availableFields) {
      const group = grouped.get(field.sourceNodeLabel);
      if (group) {
        group.push(field);
      } else {
        grouped.set(field.sourceNodeLabel, [field]);
      }
    }

    return Array.from(grouped.entries())
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([sourceLabel, fields]) => ({
        sourceLabel,
        fields: fields.toSorted((a, b) => a.path.localeCompare(b.path)),
      }));
  }, [availableFields]);

  const modelValue = storedValue.trim();
  const modelParseResult = parseConditionModel(modelValue);
  const storedModel = modelParseResult.valid ? modelParseResult.model : null;

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

  if (!parsedModel) {
    return (
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <Label className="text-sm">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
        {availableFields.length > 0 ? (
          <Button
            disabled={disabled}
            onClick={addConditionModel}
            size="sm"
            type="button"
            variant="outline"
          >
            Configure condition
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">{emptyFieldsMessage}</p>
        )}
        {modelValue && !modelParseResult.valid && (
          <p className="text-destructive text-xs">{modelParseResult.error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>

      <div className="space-y-3">
        {parsedModel.groups.map((group, groupIndex) => (
          <div key={group.id}>
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-muted px-2 py-1 font-medium text-xs">
                    {groupIndex + 1}
                  </span>
                  <span className="font-medium text-sm">Filter group</span>
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

              <div className="space-y-3 p-3">
                {group.conditions.map((condition, conditionIndex) => {
                  const selectedFieldDef = fieldByPath.get(condition.field);
                  const operatorOptions = getOperatorOptionsByFieldType(
                    condition.fieldType,
                    selectedFieldDef?.nullable
                  );
                  const canDeleteCondition = group.conditions.length > 1;
                  const isSelectedFieldUnavailable = !selectedFieldDef;

                  return (
                    <div key={condition.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          disabled={disabled || availableFields.length === 0}
                          onValueChange={whenChosen((fieldPath) => {
                            const selectedField = fieldByPath.get(fieldPath);
                            if (!selectedField) {
                              return;
                            }

                            updateCondition(
                              group.id,
                              condition.id,
                              (existing) =>
                                createDefaultConditionRule(
                                  selectedField,
                                  existing.id
                                )
                            );
                          })}
                          value={condition.field}
                        >
                          <SelectTrigger className="min-w-[280px]">
                            <SelectValue placeholder="Select field" />
                          </SelectTrigger>
                          <SelectContent>
                            {isSelectedFieldUnavailable && (
                              <SelectItem value={condition.field}>
                                {condition.field} (Unavailable)
                              </SelectItem>
                            )}
                            {availableFieldsBySource.map((fieldGroup) => (
                              <SelectGroup key={fieldGroup.sourceLabel}>
                                <SelectLabel>
                                  {fieldGroup.sourceLabel}
                                </SelectLabel>
                                {fieldGroup.fields.map((field) => (
                                  <SelectItem
                                    key={field.path}
                                    value={field.path}
                                  >
                                    <span className="flex w-full flex-col items-start">
                                      <span className="flex items-center gap-1.5">
                                        {field.label}
                                        {field.nullable && (
                                          <span className="rounded bg-muted px-1 py-0.5 font-normal text-xs text-muted-foreground leading-none">
                                            nullable
                                          </span>
                                        )}
                                      </span>
                                      {field.sourceNodeLabels.length > 1 && (
                                        <span className="text-muted-foreground text-xs">
                                          Also from{" "}
                                          {field.sourceNodeLabels
                                            .filter(
                                              (sourceLabelName) =>
                                                sourceLabelName !==
                                                fieldGroup.sourceLabel
                                            )
                                            .join(", ")}
                                        </span>
                                      )}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          disabled={disabled}
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
                          enumValues={selectedFieldDef?.enumValues}
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
                        <div className="py-2 pl-2">
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

            {groupIndex < parsedModel.groups.length - 1 && (
              <div className="flex justify-center py-2">
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
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-center">
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
          Compiled CEL: {compiled.expression}
        </p>
      )}
    </div>
  );
}
