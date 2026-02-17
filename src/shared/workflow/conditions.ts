export type ConditionFieldType = "timestamp" | "string" | "number" | "boolean";

export type TimeUnit = "minutes" | "hours" | "days" | "weeks";

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

type ConditionModelBase = {
  version: 1;
  field: string;
  fieldType: ConditionFieldType;
};

export type TimestampRelativeConditionModel = ConditionModelBase & {
  fieldType: "timestamp";
  operator: TimestampRelativeOperator;
  amount: number;
  unit: TimeUnit;
};

export type TimestampAbsoluteConditionModel = ConditionModelBase & {
  fieldType: "timestamp";
  operator: TimestampAbsoluteOperator;
  date: string;
};

export type StringConditionModel = ConditionModelBase & {
  fieldType: "string";
  operator: StringOperator;
  value: string;
};

export type NumberConditionModel = ConditionModelBase & {
  fieldType: "number";
  operator: NumberOperator;
  value: number;
};

export type BooleanConditionModel = ConditionModelBase & {
  fieldType: "boolean";
  operator: BooleanOperator;
};

export type ConditionModel =
  | TimestampRelativeConditionModel
  | TimestampAbsoluteConditionModel
  | StringConditionModel
  | NumberConditionModel
  | BooleanConditionModel;

export type ConditionModelParseResult =
  | { valid: true; model: ConditionModel }
  | { valid: false; error: string };

export type ConditionCompileResult =
  | { valid: true; expression: string }
  | { valid: false; error: string };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

export function isTimestampRelativeConditionModel(
  model: TimestampRelativeConditionModel | TimestampAbsoluteConditionModel
): model is TimestampRelativeConditionModel {
  return isTimestampRelativeOperator(model.operator);
}

export function isTimestampAbsoluteConditionModel(
  model: TimestampRelativeConditionModel | TimestampAbsoluteConditionModel
): model is TimestampAbsoluteConditionModel {
  return isTimestampAbsoluteOperator(model.operator);
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parsing validates each supported model shape explicitly for clear error messages.
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

  if (parsed.version !== 1) {
    return { valid: false, error: "Condition model version must be 1" };
  }

  if (typeof parsed.field !== "string" || parsed.field.trim().length === 0) {
    return { valid: false, error: "Condition field is required" };
  }

  if (!isConditionFieldType(parsed.fieldType)) {
    return { valid: false, error: "Condition field type is invalid" };
  }

  if (parsed.fieldType === "timestamp") {
    if (!isTimestampOperator(parsed.operator)) {
      return { valid: false, error: "Timestamp operator is invalid" };
    }

    if (isTimestampRelativeOperator(parsed.operator)) {
      if (!isPositiveInteger(parsed.amount)) {
        return {
          valid: false,
          error: "Timestamp amount must be a positive integer",
        };
      }

      if (!isTimeUnit(parsed.unit)) {
        return { valid: false, error: "Timestamp unit is invalid" };
      }

      return {
        valid: true,
        model: {
          version: 1,
          field: parsed.field,
          fieldType: "timestamp",
          operator: parsed.operator,
          amount: parsed.amount,
          unit: parsed.unit,
        },
      };
    }

    if (
      typeof parsed.date !== "string" ||
      !DATE_ONLY_PATTERN.test(parsed.date.trim())
    ) {
      return {
        valid: false,
        error: "Timestamp absolute operators require a YYYY-MM-DD date",
      };
    }

    return {
      valid: true,
      model: {
        version: 1,
        field: parsed.field,
        fieldType: "timestamp",
        operator: parsed.operator,
        date: parsed.date.trim(),
      },
    };
  }

  if (parsed.fieldType === "string") {
    if (!isStringOperator(parsed.operator)) {
      return { valid: false, error: "String operator is invalid" };
    }

    if (typeof parsed.value !== "string") {
      return { valid: false, error: "String conditions require a text value" };
    }

    return {
      valid: true,
      model: {
        version: 1,
        field: parsed.field,
        fieldType: "string",
        operator: parsed.operator,
        value: parsed.value,
      },
    };
  }

  if (parsed.fieldType === "number") {
    if (!isNumberOperator(parsed.operator)) {
      return { valid: false, error: "Number operator is invalid" };
    }

    if (typeof parsed.value !== "number" || !Number.isFinite(parsed.value)) {
      return {
        valid: false,
        error: "Number conditions require a finite numeric value",
      };
    }

    return {
      valid: true,
      model: {
        version: 1,
        field: parsed.field,
        fieldType: "number",
        operator: parsed.operator,
        value: parsed.value,
      },
    };
  }

  if (!isBooleanOperator(parsed.operator)) {
    return { valid: false, error: "Boolean operator is invalid" };
  }

  return {
    valid: true,
    model: {
      version: 1,
      field: parsed.field,
      fieldType: "boolean",
      operator: parsed.operator,
    },
  };
}

export function serializeConditionModel(model: ConditionModel): string {
  return JSON.stringify(model);
}

export function createDefaultConditionModel(
  field: ConditionFieldDefinition
): ConditionModel {
  if (field.type === "timestamp") {
    return {
      version: 1,
      field: field.path,
      fieldType: "timestamp",
      operator: "within_next",
      amount: 1,
      unit: "days",
    };
  }

  if (field.type === "number") {
    return {
      version: 1,
      field: field.path,
      fieldType: "number",
      operator: "equals",
      value: 0,
    };
  }

  if (field.type === "boolean") {
    return {
      version: 1,
      field: field.path,
      fieldType: "boolean",
      operator: "is_true",
    };
  }

  return {
    version: 1,
    field: field.path,
    fieldType: "string",
    operator: "equals",
    value: "",
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Compiler keeps one branch per operator for deterministic CEL output.
export function compileConditionModel(
  model: ConditionModel
): ConditionCompileResult {
  const field = model.field.trim();

  if (!field) {
    return { valid: false, error: "Condition field is required" };
  }

  if (model.fieldType === "timestamp") {
    if (isTimestampRelativeConditionModel(model)) {
      const amount = model.amount;
      if (!isPositiveInteger(amount)) {
        return {
          valid: false,
          error: "Timestamp amount must be a positive integer",
        };
      }

      if (!isTimeUnit(model.unit)) {
        return { valid: false, error: "Timestamp unit is invalid" };
      }

      const unitFunction = model.unit;
      if (model.operator === "within_next") {
        return {
          valid: true,
          expression: `${field} > now && ${field} < now + ${unitFunction}(${amount})`,
        };
      }

      if (model.operator === "more_than_from_now") {
        return {
          valid: true,
          expression: `${field} > now + ${unitFunction}(${amount})`,
        };
      }

      if (model.operator === "less_than_ago") {
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

    if (!isTimestampAbsoluteConditionModel(model)) {
      return { valid: false, error: "Timestamp operator is invalid" };
    }

    if (!DATE_ONLY_PATTERN.test(model.date)) {
      return {
        valid: false,
        error: "Timestamp absolute operators require a YYYY-MM-DD date",
      };
    }

    if (model.operator === "before") {
      return {
        valid: true,
        expression: `${field} < date("${model.date}")`,
      };
    }

    return {
      valid: true,
      expression: `${field} > date("${model.date}")`,
    };
  }

  if (model.fieldType === "string") {
    const value = JSON.stringify(model.value);

    if (model.operator === "equals") {
      return { valid: true, expression: `${field} == ${value}` };
    }

    if (model.operator === "not_equals") {
      return { valid: true, expression: `${field} != ${value}` };
    }

    return { valid: true, expression: `${field}.contains(${value})` };
  }

  if (model.fieldType === "number") {
    if (!Number.isFinite(model.value)) {
      return {
        valid: false,
        error: "Number conditions require a finite numeric value",
      };
    }

    return {
      valid: true,
      expression: `${field} ${toOperatorExpression(model.operator)} ${model.value}`,
    };
  }

  if (model.operator === "is_true") {
    return { valid: true, expression: `${field} == true` };
  }

  return { valid: true, expression: `${field} == false` };
}
