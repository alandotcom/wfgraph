import { z } from "zod";
import { decodeIsoTimestamp } from "@/types/timestamp";

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

export type NullCheckOperator = "is_set" | "is_not_set";

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

export type NullCheckConditionRule = ConditionRuleBase & {
  operator: NullCheckOperator;
};

export type ConditionRule =
  | TimestampRelativeConditionRule
  | TimestampAbsoluteConditionRule
  | StringConditionRule
  | NumberConditionRule
  | BooleanConditionRule
  | NullCheckConditionRule;

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

export const NULLCHECK_OPERATOR_OPTIONS: Array<{
  value: NullCheckOperator;
  label: string;
}> = [
  { value: "is_set", label: "is set" },
  { value: "is_not_set", label: "is not set" },
];

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

export function isNullCheckOperator(
  value: unknown
): value is NullCheckOperator {
  return value === "is_set" || value === "is_not_set";
}

export function isNullCheckConditionRule(
  rule: ConditionRule
): rule is NullCheckConditionRule {
  return isNullCheckOperator(rule.operator);
}

/**
 * A `before`/`after` rule stores the moment the user picked as text, so what
 * counts as a valid one is the shared timestamp contract: ISO 8601 carrying an
 * explicit zone. The builder writes these through `Date.toISOString()`, and a
 * rule that named a wall-clock time with no zone would compare against payloads
 * from any zone and mean something different each time.
 */
function isIsoTimestamp(value: string): boolean {
  return decodeIsoTimestamp(value) !== null;
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

/**
 * The stored form of a condition model.
 *
 * A Condition node keeps its structured model as a JSON string in node config,
 * so the model arrives here as outside input and is parsed before anything
 * reads it. Rules are described in two layers: `fieldType` says what kind of
 * value the field holds, and `operator` then says which operands the rule
 * carries. Every layer carries its own message, so a model that will not load
 * names the thing that is actually wrong with it.
 *
 * Unknown keys are dropped, so a rule that kept an operand from an operator the
 * user has since changed away from still loads, without that operand.
 */
function requiredTextSchema(message: string) {
  return z.string({ error: message }).trim().min(1, { error: message });
}

/** The parts every rule carries, whatever kind of field it points at. */
function conditionRuleShape<TFieldType extends ConditionFieldType>(
  fieldType: TFieldType
) {
  return {
    id: requiredTextSchema("Condition id is required"),
    field: requiredTextSchema("Condition field is required"),
    fieldType: z.literal(fieldType),
  };
}

/** Null checks read a field's presence, so they take no operand of their own. */
const nullCheckOperatorSchema = z.enum(["is_set", "is_not_set"]);

const TIMESTAMP_AMOUNT_ERROR = "Timestamp amount must be a positive integer";
const DATE_TIME_ERROR =
  "Timestamp absolute operators require a valid date-time";

const timestampConditionRuleSchema = z.discriminatedUnion(
  "operator",
  [
    z.object({
      ...conditionRuleShape("timestamp"),
      operator: nullCheckOperatorSchema,
    }),
    z.object({
      ...conditionRuleShape("timestamp"),
      operator: z.enum([
        "within_next",
        "more_than_from_now",
        "less_than_ago",
        "more_than_ago",
      ]),
      amount: z
        .number({ error: TIMESTAMP_AMOUNT_ERROR })
        .int({ error: TIMESTAMP_AMOUNT_ERROR })
        .positive({ error: TIMESTAMP_AMOUNT_ERROR }),
      unit: z.enum(["minutes", "hours", "days", "weeks"], {
        error: "Timestamp unit is invalid",
      }),
    }),
    z.object({
      ...conditionRuleShape("timestamp"),
      operator: z.enum(["before", "after"]),
      dateTime: z
        .string({ error: DATE_TIME_ERROR })
        .trim()
        .refine(isIsoTimestamp, { error: DATE_TIME_ERROR }),
    }),
  ],
  { error: "Timestamp operator is invalid" }
);

const stringConditionRuleSchema = z.discriminatedUnion(
  "operator",
  [
    z.object({
      ...conditionRuleShape("string"),
      operator: nullCheckOperatorSchema,
    }),
    z.object({
      ...conditionRuleShape("string"),
      operator: z.enum(["equals", "not_equals", "contains"]),
      value: z.string({ error: "String conditions require a text value" }),
    }),
  ],
  { error: "String operator is invalid" }
);

const numberConditionRuleSchema = z.discriminatedUnion(
  "operator",
  [
    z.object({
      ...conditionRuleShape("number"),
      operator: nullCheckOperatorSchema,
    }),
    z.object({
      ...conditionRuleShape("number"),
      operator: z.enum([
        "equals",
        "not_equals",
        "greater_than",
        "greater_or_equal",
        "less_than",
        "less_or_equal",
      ]),
      // z.number() admits finite numbers only, which is the operand a
      // comparison can be compiled against.
      value: z.number({
        error: "Number conditions require a finite numeric value",
      }),
    }),
  ],
  { error: "Number operator is invalid" }
);

const booleanConditionRuleSchema = z.discriminatedUnion(
  "operator",
  [
    z.object({
      ...conditionRuleShape("boolean"),
      operator: nullCheckOperatorSchema,
    }),
    z.object({
      ...conditionRuleShape("boolean"),
      operator: z.enum(["is_true", "is_false"]),
    }),
  ],
  { error: "Boolean operator is invalid" }
);

/**
 * A rule has to be an object before its field type can be read, and the gate in
 * front of the union is what lets a rule that is a string or an array say so.
 */
const conditionRuleSchema = z
  .looseObject({}, { error: "Condition must be an object" })
  .pipe(
    z.discriminatedUnion(
      "fieldType",
      [
        timestampConditionRuleSchema,
        stringConditionRuleSchema,
        numberConditionRuleSchema,
        booleanConditionRuleSchema,
      ],
      { error: "Condition field type is invalid" }
    )
  );

const GROUP_CONDITIONS_ERROR = "Each group must contain at least one condition";

const conditionGroupSchema = z.object(
  {
    id: requiredTextSchema("Group id is required"),
    logic: z.enum(["and", "or"], { error: "Group logic is invalid" }),
    conditions: z
      .array(conditionRuleSchema, { error: GROUP_CONDITIONS_ERROR })
      .min(1, { error: GROUP_CONDITIONS_ERROR }),
  },
  { error: "Group must be an object" }
);

const MODEL_GROUPS_ERROR = "Condition model must contain at least one group";

const conditionModelSchema = z.object(
  {
    version: z.literal(2, { error: "Condition model version must be 2" }),
    groupLogic: z.enum(["and", "or"], {
      error: "Condition model group logic is invalid",
    }),
    groups: z
      .array(conditionGroupSchema, { error: MODEL_GROUPS_ERROR })
      .min(1, { error: MODEL_GROUPS_ERROR }),
  },
  { error: "Condition model must be an object" }
);

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

  const model = conditionModelSchema.safeParse(parsed);
  if (!model.success) {
    // Issues arrive in the order the model declares its parts, so the first one
    // is the earliest thing wrong and the one worth reporting.
    const [firstIssue] = model.error.issues;
    return {
      valid: false,
      error: firstIssue ? firstIssue.message : "Condition model is invalid",
    };
  }

  return { valid: true, model: model.data };
}

export function serializeConditionModel(model: ConditionModel): string {
  return JSON.stringify(model);
}

/**
 * The field paths this model reads as timestamps.
 *
 * The compiled CEL string keeps no record of which fields are timestamps, but
 * the model it was compiled from does: the builder only offers timestamp
 * operators for a field the schema marked `timestamp`. Whoever assembles the
 * evaluation context needs that list, because a payload delivers a timestamp as
 * an ISO string and CEL has no overload comparing a string to a Timestamp.
 *
 * Paths repeat when several rules read the same field, so the list is deduped.
 */
export function collectTimestampFieldPaths(model: ConditionModel): string[] {
  const paths = new Set<string>();

  for (const group of model.groups) {
    for (const rule of group.conditions) {
      if (rule.fieldType !== "timestamp") {
        continue;
      }

      const field = rule.field.trim();
      if (field) {
        paths.add(field);
      }
    }
  }

  return [...paths];
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

  if (!isIsoTimestamp(rule.dateTime)) {
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

function compileNullCheckConditionRule(
  rule: NullCheckConditionRule,
  field: string
): ConditionCompileResult {
  if (rule.operator === "is_set") {
    return { valid: true, expression: `${field} != null` };
  }

  return { valid: true, expression: `${field} == null` };
}

function compileConditionRule(rule: ConditionRule): ConditionCompileResult {
  const field = rule.field.trim();
  if (!field) {
    return { valid: false, error: "Condition field is required" };
  }

  if (isNullCheckConditionRule(rule)) {
    return compileNullCheckConditionRule(rule, field);
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
