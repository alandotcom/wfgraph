import {
  BOOLEAN_OPERATOR_OPTIONS,
  type ConditionFieldType,
  type ConditionRule,
  isNullCheckConditionRule,
  isTimestampAbsoluteConditionRule,
  isTimestampRelativeConditionRule,
  NULLCHECK_OPERATOR_OPTIONS,
  NUMBER_OPERATOR_OPTIONS,
  STRING_OPERATOR_OPTIONS,
  TIMESTAMP_OPERATOR_OPTIONS,
  type TimestampAbsoluteOperator,
  type TimestampRelativeOperator,
} from "@wfgraph/shared/conditions/conditions";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

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

export function getOperatorOptionsByFieldType(
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
      ...omitUndefined({ recordKey: condition.recordKey }),
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
      ...omitUndefined({ recordKey: condition.recordKey }),
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

export function applyOperatorValueToCondition(
  condition: ConditionRule,
  operatorValue: string
): ConditionRule | null {
  const base = {
    id: condition.id,
    field: condition.field,
    ...omitUndefined({ recordKey: condition.recordKey }),
  };

  if (isNullCheckOperatorValue(operatorValue)) {
    return {
      ...base,
      fieldType: condition.fieldType,
      operator: operatorValue,
    };
  }

  if (condition.fieldType === "timestamp") {
    // A timestamp operator needs defaults when the previous operator was a null check.
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
