export type ConditionFieldType = "timestamp" | "string" | "number" | "boolean";

export type TimeUnit = "minutes" | "hours" | "days" | "weeks";

export type GroupLogic = "and" | "or";

export type TimestampRelativeOperator =
  | "within_next"
  | "more_than_from_now"
  | "less_than_ago"
  | "more_than_ago";

export type TimestampAbsoluteOperator = "before" | "after";

export type TimestampOperator =
  | TimestampRelativeOperator
  | TimestampAbsoluteOperator;

export type StringOperator = "equals" | "not_equals" | "contains";

export type NumberOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal";

export type BooleanOperator = "is_true" | "is_false";

export type ConditionOperator =
  | TimestampOperator
  | StringOperator
  | NumberOperator
  | BooleanOperator;

export type ConditionFieldDefinition = {
  path: string;
  label: string;
  type: ConditionFieldType;
};

type ConditionRuleBase = {
  id: string;
  field: string;
  fieldType: ConditionFieldType;
};

export type TimestampRelativeConditionRule = ConditionRuleBase & {
  fieldType: "timestamp";
  operator: TimestampRelativeOperator;
  amount: number;
  unit: TimeUnit;
};

export type TimestampAbsoluteConditionRule = ConditionRuleBase & {
  fieldType: "timestamp";
  operator: TimestampAbsoluteOperator;
  dateTime: string;
};

export type StringConditionRule = ConditionRuleBase & {
  fieldType: "string";
  operator: StringOperator;
  value: string;
};

export type NumberConditionRule = ConditionRuleBase & {
  fieldType: "number";
  operator: NumberOperator;
  value: number;
};

export type BooleanConditionRule = ConditionRuleBase & {
  fieldType: "boolean";
  operator: BooleanOperator;
};

export type ConditionRule =
  | TimestampRelativeConditionRule
  | TimestampAbsoluteConditionRule
  | StringConditionRule
  | NumberConditionRule
  | BooleanConditionRule;

export type ConditionGroup = {
  id: string;
  logic: GroupLogic;
  conditions: ConditionRule[];
};

export type ConditionModel = {
  version: 2;
  groupLogic: GroupLogic;
  groups: ConditionGroup[];
};

export type ConditionModelParseResult =
  | { valid: true; model: ConditionModel }
  | { valid: false; error: string };

export type ConditionCompileResult =
  | { valid: true; expression: string }
  | { valid: false; error: string };

export const GROUP_LOGIC_OPTIONS: Array<{
  value: GroupLogic;
  label: string;
}> = [
  { value: "and", label: "AND" },
  { value: "or", label: "OR" },
];

export const TIMESTAMP_OPERATOR_OPTIONS: Array<{
  value: TimestampOperator;
  label: string;
}> = [
  { value: "within_next", label: "is within the next" },
  { value: "more_than_from_now", label: "is more than from now" },
  { value: "less_than_ago", label: "is less than ago" },
  { value: "more_than_ago", label: "is more than ago" },
  { value: "before", label: "is before" },
  { value: "after", label: "is after" },
];

export const TIME_UNIT_OPTIONS: Array<{ value: TimeUnit; label: string }> = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
];

export const STRING_OPERATOR_OPTIONS: Array<{
  value: StringOperator;
  label: string;
}> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
];

export const NUMBER_OPERATOR_OPTIONS: Array<{
  value: NumberOperator;
  label: string;
}> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "greater_than", label: "is greater than" },
  { value: "greater_or_equal", label: "is greater than or equal" },
  { value: "less_than", label: "is less than" },
  { value: "less_or_equal", label: "is less than or equal" },
];

export const BOOLEAN_OPERATOR_OPTIONS: Array<{
  value: BooleanOperator;
  label: string;
}> = [
  { value: "is_true", label: "is true" },
  { value: "is_false", label: "is false" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGroupLogic(value: unknown): value is GroupLogic {
  return value === "and" || value === "or";
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function isConditionFieldType(value: unknown): value is ConditionFieldType {
  return (
    value === "timestamp" ||
    value === "string" ||
    value === "number" ||
    value === "boolean"
  );
}

function isTimestampOperator(value: unknown): value is TimestampOperator {
  return TIMESTAMP_OPERATOR_OPTIONS.some((option) => option.value === value);
}

function isTimestampRelativeOperator(
  value: unknown
): value is TimestampRelativeOperator {
  return (
    value === "within_next" ||
    value === "more_than_from_now" ||
    value === "less_than_ago" ||
    value === "more_than_ago"
  );
}

function isTimestampAbsoluteOperator(
  value: unknown
): value is TimestampAbsoluteOperator {
  return value === "before" || value === "after";
}

export function isTimestampRelativeConditionRule(
  rule: TimestampRelativeConditionRule | TimestampAbsoluteConditionRule
): rule is TimestampRelativeConditionRule {
  return isTimestampRelativeOperator(rule.operator);
}

export function isTimestampAbsoluteConditionRule(
  rule: TimestampRelativeConditionRule | TimestampAbsoluteConditionRule
): rule is TimestampAbsoluteConditionRule {
  return isTimestampAbsoluteOperator(rule.operator);
}

function isTimeUnit(value: unknown): value is TimeUnit {
  return (
    value === "minutes" ||
    value === "hours" ||
    value === "days" ||
    value === "weeks"
  );
}

function isStringOperator(value: unknown): value is StringOperator {
  return value === "equals" || value === "not_equals" || value === "contains";
}

function isNumberOperator(value: unknown): value is NumberOperator {
  return NUMBER_OPERATOR_OPTIONS.some((option) => option.value === value);
}

function isBooleanOperator(value: unknown): value is BooleanOperator {
  return value === "is_true" || value === "is_false";
}

function isDateTimeString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed.includes("T")) {
    return false;
  }

  const parsed = new Date(trimmed);
  return !Number.isNaN(parsed.getTime());
}

function toOperatorExpression(operator: NumberOperator): string {
  switch (operator) {
    case "equals":
      return "==";
    case "not_equals":
      return "!=";
    case "greater_than":
      return ">";
    case "greater_or_equal":
      return ">=";
    case "less_than":
      return "<";
    case "less_or_equal":
      return "<=";
    default:
      return "==";
  }
}

function parseTimestampConditionRule(input: {
  id: string;
  field: string;
  operator: unknown;
  amount: unknown;
  unit: unknown;
  dateTime: unknown;
}): { valid: true; rule: ConditionRule } | { valid: false; error: string } {
  if (!isTimestampOperator(input.operator)) {
    return { valid: false, error: "Timestamp operator is invalid" };
  }

  if (isTimestampRelativeOperator(input.operator)) {
    if (!isPositiveInteger(input.amount)) {
      return {
        valid: false,
        error: "Timestamp amount must be a positive integer",
      };
    }

    if (!isTimeUnit(input.unit)) {
      return { valid: false, error: "Timestamp unit is invalid" };
    }

    return {
      valid: true,
      rule: {
        id: input.id,
        field: input.field,
        fieldType: "timestamp",
        operator: input.operator,
        amount: input.amount,
        unit: input.unit,
      },
    };
  }

  if (!isDateTimeString(input.dateTime)) {
    return {
      valid: false,
      error: "Timestamp absolute operators require a valid date-time",
    };
  }

  return {
    valid: true,
    rule: {
      id: input.id,
      field: input.field,
      fieldType: "timestamp",
      operator: input.operator,
      dateTime: input.dateTime.trim(),
    },
  };
}

function parseStringConditionRule(input: {
  id: string;
  field: string;
  operator: unknown;
  value: unknown;
}): { valid: true; rule: ConditionRule } | { valid: false; error: string } {
  if (!isStringOperator(input.operator)) {
    return { valid: false, error: "String operator is invalid" };
  }

  if (typeof input.value !== "string") {
    return { valid: false, error: "String conditions require a text value" };
  }

  return {
    valid: true,
    rule: {
      id: input.id,
      field: input.field,
      fieldType: "string",
      operator: input.operator,
      value: input.value,
    },
  };
}

function parseNumberConditionRule(input: {
  id: string;
  field: string;
  operator: unknown;
  value: unknown;
}): { valid: true; rule: ConditionRule } | { valid: false; error: string } {
  if (!isNumberOperator(input.operator)) {
    return { valid: false, error: "Number operator is invalid" };
  }

  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return {
      valid: false,
      error: "Number conditions require a finite numeric value",
    };
  }

  return {
    valid: true,
    rule: {
      id: input.id,
      field: input.field,
      fieldType: "number",
      operator: input.operator,
      value: input.value,
    },
  };
}

function parseBooleanConditionRule(input: {
  id: string;
  field: string;
  operator: unknown;
}): { valid: true; rule: ConditionRule } | { valid: false; error: string } {
  if (!isBooleanOperator(input.operator)) {
    return { valid: false, error: "Boolean operator is invalid" };
  }

  return {
    valid: true,
    rule: {
      id: input.id,
      field: input.field,
      fieldType: "boolean",
      operator: input.operator,
    },
  };
}

function parseConditionRule(
  input: unknown
): { valid: true; rule: ConditionRule } | { valid: false; error: string } {
  if (!isRecord(input)) {
    return { valid: false, error: "Condition must be an object" };
  }

  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    return { valid: false, error: "Condition id is required" };
  }

  if (typeof input.field !== "string" || input.field.trim().length === 0) {
    return { valid: false, error: "Condition field is required" };
  }

  if (!isConditionFieldType(input.fieldType)) {
    return { valid: false, error: "Condition field type is invalid" };
  }

  const normalized = {
    id: input.id,
    field: input.field.trim(),
    operator: input.operator,
    value: input.value,
    amount: input.amount,
    unit: input.unit,
    dateTime: input.dateTime,
  };

  if (input.fieldType === "timestamp") {
    return parseTimestampConditionRule(normalized);
  }

  if (input.fieldType === "string") {
    return parseStringConditionRule(normalized);
  }

  if (input.fieldType === "number") {
    return parseNumberConditionRule(normalized);
  }

  return parseBooleanConditionRule(normalized);
}

function parseConditionGroup(
  input: unknown
): { valid: true; group: ConditionGroup } | { valid: false; error: string } {
  if (!isRecord(input)) {
    return { valid: false, error: "Group must be an object" };
  }

  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    return { valid: false, error: "Group id is required" };
  }

  if (!isGroupLogic(input.logic)) {
    return { valid: false, error: "Group logic is invalid" };
  }

  if (!Array.isArray(input.conditions) || input.conditions.length === 0) {
    return {
      valid: false,
      error: "Each group must contain at least one condition",
    };
  }

  const parsedConditions: ConditionRule[] = [];
  for (const condition of input.conditions) {
    const parsedCondition = parseConditionRule(condition);
    if (!parsedCondition.valid) {
      return parsedCondition;
    }
    parsedConditions.push(parsedCondition.rule);
  }

  return {
    valid: true,
    group: {
      id: input.id,
      logic: input.logic,
      conditions: parsedConditions,
    },
  };
}

export function parseConditionModel(input: unknown): ConditionModelParseResult {
  let parsed: unknown = input;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      return { valid: false, error: "Condition model is empty" };
    }

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { valid: false, error: "Condition model must be valid JSON" };
    }
  }

  if (!isRecord(parsed)) {
    return { valid: false, error: "Condition model must be an object" };
  }

  if (parsed.version !== 2) {
    return { valid: false, error: "Condition model version must be 2" };
  }

  if (!isGroupLogic(parsed.groupLogic)) {
    return { valid: false, error: "Condition model group logic is invalid" };
  }

  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    return {
      valid: false,
      error: "Condition model must contain at least one group",
    };
  }

  const parsedGroups: ConditionGroup[] = [];
  for (const group of parsed.groups) {
    const parsedGroup = parseConditionGroup(group);
    if (!parsedGroup.valid) {
      return parsedGroup;
    }
    parsedGroups.push(parsedGroup.group);
  }

  return {
    valid: true,
    model: {
      version: 2,
      groupLogic: parsed.groupLogic,
      groups: parsedGroups,
    },
  };
}

export function serializeConditionModel(model: ConditionModel): string {
  return JSON.stringify(model);
}

export function createDefaultConditionRule(
  field: ConditionFieldDefinition,
  id = "rule"
): ConditionRule {
  if (field.type === "timestamp") {
    return {
      id,
      field: field.path,
      fieldType: "timestamp",
      operator: "within_next",
      amount: 1,
      unit: "days",
    };
  }

  if (field.type === "number") {
    return {
      id,
      field: field.path,
      fieldType: "number",
      operator: "equals",
      value: 0,
    };
  }

  if (field.type === "boolean") {
    return {
      id,
      field: field.path,
      fieldType: "boolean",
      operator: "is_true",
    };
  }

  return {
    id,
    field: field.path,
    fieldType: "string",
    operator: "equals",
    value: "",
  };
}

export function createDefaultConditionModel(
  field: ConditionFieldDefinition,
  input?: { groupId?: string; conditionId?: string }
): ConditionModel {
  return {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: input?.groupId ?? "group",
        logic: "and",
        conditions: [
          createDefaultConditionRule(field, input?.conditionId ?? "rule"),
        ],
      },
    ],
  };
}

function compileTimestampConditionRule(
  rule: TimestampRelativeConditionRule | TimestampAbsoluteConditionRule,
  field: string
): ConditionCompileResult {
  if (isTimestampRelativeConditionRule(rule)) {
    const amount = rule.amount;
    if (!isPositiveInteger(amount)) {
      return {
        valid: false,
        error: "Timestamp amount must be a positive integer",
      };
    }

    if (!isTimeUnit(rule.unit)) {
      return { valid: false, error: "Timestamp unit is invalid" };
    }

    const unitFunction = rule.unit;
    if (rule.operator === "within_next") {
      return {
        valid: true,
        expression: `${field} > now && ${field} < now + ${unitFunction}(${amount})`,
      };
    }

    if (rule.operator === "more_than_from_now") {
      return {
        valid: true,
        expression: `${field} > now + ${unitFunction}(${amount})`,
      };
    }

    if (rule.operator === "less_than_ago") {
      return {
        valid: true,
        expression: `${field} > now - ${unitFunction}(${amount})`,
      };
    }

    return {
      valid: true,
      expression: `${field} < now - ${unitFunction}(${amount})`,
    };
  }

  if (!isDateTimeString(rule.dateTime)) {
    return {
      valid: false,
      error: "Timestamp absolute operators require a valid date-time",
    };
  }

  const serializedDateTime = JSON.stringify(rule.dateTime.trim());
  if (rule.operator === "before") {
    return {
      valid: true,
      expression: `${field} < date(${serializedDateTime})`,
    };
  }

  return {
    valid: true,
    expression: `${field} > date(${serializedDateTime})`,
  };
}

function compileStringConditionRule(
  rule: StringConditionRule,
  field: string
): ConditionCompileResult {
  const value = JSON.stringify(rule.value);

  if (rule.operator === "equals") {
    return { valid: true, expression: `${field} == ${value}` };
  }

  if (rule.operator === "not_equals") {
    return { valid: true, expression: `${field} != ${value}` };
  }

  return { valid: true, expression: `${field}.contains(${value})` };
}

function compileNumberConditionRule(
  rule: NumberConditionRule,
  field: string
): ConditionCompileResult {
  if (!Number.isFinite(rule.value)) {
    return {
      valid: false,
      error: "Number conditions require a finite numeric value",
    };
  }

  return {
    valid: true,
    expression: `${field} ${toOperatorExpression(rule.operator)} ${rule.value}`,
  };
}

function compileBooleanConditionRule(
  rule: BooleanConditionRule,
  field: string
): ConditionCompileResult {
  if (rule.operator === "is_true") {
    return { valid: true, expression: `${field} == true` };
  }

  return { valid: true, expression: `${field} == false` };
}

function compileConditionRule(rule: ConditionRule): ConditionCompileResult {
  const field = rule.field.trim();
  if (!field) {
    return { valid: false, error: "Condition field is required" };
  }

  if (rule.fieldType === "timestamp") {
    return compileTimestampConditionRule(rule, field);
  }

  if (rule.fieldType === "string") {
    return compileStringConditionRule(rule, field);
  }

  if (rule.fieldType === "number") {
    return compileNumberConditionRule(rule, field);
  }

  return compileBooleanConditionRule(rule, field);
}

function compileConditionGroup(group: ConditionGroup): ConditionCompileResult {
  if (group.conditions.length === 0) {
    return {
      valid: false,
      error: "Each group must contain at least one condition",
    };
  }

  const compiledConditions: string[] = [];
  for (const condition of group.conditions) {
    const compiledCondition = compileConditionRule(condition);
    if (!compiledCondition.valid) {
      return compiledCondition;
    }

    compiledConditions.push(`(${compiledCondition.expression})`);
  }

  const separator = group.logic === "and" ? " && " : " || ";
  return {
    valid: true,
    expression: compiledConditions.join(separator),
  };
}

export function compileConditionModel(
  model: ConditionModel
): ConditionCompileResult {
  if (!isGroupLogic(model.groupLogic)) {
    return { valid: false, error: "Condition model group logic is invalid" };
  }

  if (model.groups.length === 0) {
    return {
      valid: false,
      error: "Condition model must contain at least one group",
    };
  }

  const compiledGroups: string[] = [];
  for (const group of model.groups) {
    if (!isGroupLogic(group.logic)) {
      return { valid: false, error: "Group logic is invalid" };
    }

    const compiledGroup = compileConditionGroup(group);
    if (!compiledGroup.valid) {
      return compiledGroup;
    }

    compiledGroups.push(`(${compiledGroup.expression})`);
  }

  const separator = model.groupLogic === "and" ? " && " : " || ";
  return {
    valid: true,
    expression: compiledGroups.join(separator),
  };
}
