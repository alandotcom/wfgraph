import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { DateTimeInput } from "@astryxdesign/core/DateTimeInput";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Section } from "@astryxdesign/core/Section";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Plus, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useMemo } from "react";
import { TemplateBadgeInput } from "#src/components/form-fields/template-badge-input";
import { toISODateTimeString } from "#src/lib/astryx-input-values";
import type { ConditionSelectableField } from "#src/lib/upstream-node-fields";
import { ConditionFieldCombobox } from "./condition-field-combobox";
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
} from "@wfgraph/shared/conditions/conditions";

/**
 * What the row is written against, rather than where it is stored.
 *
 * Two callers build rules with it and neither keeps them the same way: a
 * Condition node stores a model and the CEL it compiles to on its own config, a
 * Wait Subscription stores the model alone and compiles it at park time, against
 * a payload that has not arrived yet. So the row takes its vocabulary and its
 * value as props and hands back both halves, leaving the storing to the caller.
 *
 * The row draws no frame of its own: nesting a bordered box inside the caller's
 * section card is the artifact this builder was rethought to remove. The caller
 * frames it — the Condition node wraps it in a section card like any other
 * panel region; the Wait subscription renders it bare under its event heading.
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
    <SegmentedControl
      isDisabled={disabled}
      label="Condition logic"
      onChange={(next) => {
        if (next === "and" || next === "or") {
          onChange(next);
        }
      }}
      size="sm"
      value={value}
    >
      {GROUP_LOGIC_OPTIONS.map((option) => {
        return (
          <SegmentedControlItem
            key={option.value}
            label={option.label}
            value={option.value}
          />
        );
      })}
    </SegmentedControl>
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
          <NumberInput
            isDisabled={disabled}
            isLabelHidden
            label="Amount"
            min={1}
            onChange={(next) => {
              onConditionChange({
                ...condition,
                amount: Math.max(next, 1),
              });
            }}
            value={condition.amount}
            width={96}
          />
          <Selector
            isDisabled={disabled}
            isLabelHidden
            label="Time unit"
            onChange={(value) => {
              if (!isTimeUnitValue(value)) {
                return;
              }
              onConditionChange({
                ...condition,
                unit: value,
              });
            }}
            options={TIME_UNIT_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            placement="below"
            value={condition.unit}
            width={144}
          />
        </>
      );
    }

    return (
      <DateTimeInput
        isDisabled={disabled}
        isLabelHidden
        label="Date and time"
        onChange={(value) => {
          if (!isTimestampAbsoluteConditionRule(condition)) {
            return;
          }

          onConditionChange({
            ...condition,
            dateTime: toIsoDateTime(value ?? ""),
          });
        }}
        value={
          isTimestampAbsoluteConditionRule(condition)
            ? toISODateTimeString(toLocalDateTimeInput(condition.dateTime))
            : undefined
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
        <Selector
          isDisabled={disabled}
          isLabelHidden
          label="Value"
          onChange={(value) => {
            onConditionChange({ ...condition, value });
          }}
          options={enumValues.map((option) => ({
            value: option,
            label: option,
          }))}
          placement="below"
          placeholder="Select value"
          // The field declares the whole of what this picker offers. A rule
          // still holding a value the field no longer names selects nothing,
          // which leaves the placeholder standing and the rule invalid until
          // one of the offered values is chosen.
          value={
            enumValues.includes(condition.value) ? condition.value : undefined
          }
          width={240}
        />
      );
    }

    return (
      <TemplateBadgeInput
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
        xstyle={styles.valueField}
      />
    );
  }

  if (condition.fieldType === "number") {
    return (
      <NumberInput
        isDisabled={disabled}
        isLabelHidden
        label="Value"
        onChange={(next) => {
          onConditionChange({
            ...condition,
            value: next,
          });
        }}
        placeholder="0"
        value={condition.value}
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
      <VStack gap={2}>
        <Text type="label">{label}</Text>
        <Text color="secondary" type="supporting">
          {description}
        </Text>
        {availableFields.length > 0 ? (
          <Button
            isDisabled={disabled}
            label="Configure condition"
            onClick={addConditionModel}
            size="sm"
            variant="secondary"
          />
        ) : (
          <Text color="secondary" type="supporting">
            {emptyFieldsMessage}
          </Text>
        )}
        {modelValue && !modelParseResult.valid && (
          <Text type="supporting" xstyle={styles.errorText}>
            {modelParseResult.error}
          </Text>
        )}
      </VStack>
    );
  }

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Text type="label">{label}</Text>
        <Text color="secondary" type="supporting">
          {description}
        </Text>
      </VStack>

      <VStack gap={3}>
        {parsedModel.groups.map((group, groupIndex) => (
          <VStack gap={2} key={group.id}>
            <Section padding={3} variant="section">
              <VStack gap={3}>
                <HStack align="center" gap={2} justify="between">
                  <HStack align="center" gap={2} wrap="wrap">
                    <Text type="label">Filter group {groupIndex + 1}</Text>
                    <Text type="supporting">
                      {group.conditions.length}{" "}
                      {group.conditions.length === 1
                        ? "condition"
                        : "conditions"}
                    </Text>
                  </HStack>
                  <IconButton
                    icon={<Icon icon={Trash2} size="sm" />}
                    isDisabled={disabled || parsedModel.groups.length <= 1}
                    label={`Remove filter group ${groupIndex + 1}`}
                    onClick={() => removeGroup(group.id)}
                    size="sm"
                    variant="ghost"
                  />
                </HStack>

                <VStack gap={3}>
                  {group.conditions.map((condition, conditionIndex) => {
                    const selectedFieldDef = fieldByPath.get(condition.field);
                    const operatorOptions = getOperatorOptionsByFieldType(
                      condition.fieldType,
                      selectedFieldDef?.nullable
                    );
                    const canDeleteCondition = group.conditions.length > 1;

                    return (
                      <VStack gap={2} key={condition.id}>
                        <HStack align="center" gap={2} wrap="wrap">
                          <ConditionFieldCombobox
                            disabled={disabled || availableFields.length === 0}
                            fields={availableFields}
                            onValueChange={(nextField) => {
                              if (nextField.path === condition.field) {
                                return;
                              }

                              updateCondition(
                                group.id,
                                condition.id,
                                (existing) =>
                                  createDefaultConditionRule(
                                    nextField,
                                    existing.id
                                  )
                              );
                            }}
                            valuePath={condition.field}
                          />

                          <Selector
                            isDisabled={disabled}
                            isLabelHidden
                            label="Operator"
                            onChange={(operatorValue) => {
                              const nextCondition =
                                applyOperatorValueToCondition(
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
                            }}
                            options={operatorOptions.map((option) => ({
                              value: option.value,
                              label: option.label,
                            }))}
                            placement="below"
                            placeholder="Select operator"
                            value={condition.operator}
                            width={190}
                          />

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

                          <IconButton
                            icon={<Icon icon={Trash2} size="sm" />}
                            isDisabled={disabled || !canDeleteCondition}
                            label="Remove condition"
                            onClick={() =>
                              removeConditionFromGroup(group.id, condition.id)
                            }
                            size="sm"
                            variant="ghost"
                          />
                        </HStack>

                        {conditionIndex < group.conditions.length - 1 && (
                          <HStack paddingBlock={2} paddingInline={2}>
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
                          </HStack>
                        )}
                      </VStack>
                    );
                  })}

                  <Button
                    icon={<Icon icon={Plus} size="sm" />}
                    isDisabled={disabled || !seedField}
                    label="Add condition"
                    onClick={() => addConditionToGroup(group.id)}
                    size="sm"
                    variant="ghost"
                  />
                </VStack>
              </VStack>
            </Section>

            {groupIndex < parsedModel.groups.length - 1 && (
              <HStack justify="center" paddingBlock={2}>
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
              </HStack>
            )}
          </VStack>
        ))}
      </VStack>

      <HStack justify="center">
        <Button
          icon={<Icon icon={Plus} size="sm" />}
          isDisabled={disabled || !seedField}
          label="Add group"
          onClick={addGroup}
          size="sm"
          variant="secondary"
        />
      </HStack>

      {compiled?.valid === false && (
        <Text type="supporting" xstyle={styles.errorText}>
          {compiled.error}
        </Text>
      )}
      {compiled?.valid && (
        <Text color="secondary" type="supporting">
          Compiled CEL: {compiled.expression}
        </Text>
      )}
    </VStack>
  );
}

const styles = stylex.create({
  valueField: {
    minWidth: 240,
  },
  errorText: {
    color: colorVars["--color-text-red"],
  },
});
