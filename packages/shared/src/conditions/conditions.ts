import { Result, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { decodeIsoTimestamp } from "#src/types/timestamp";

/**
 * The single CEL root every condition field hangs off.
 *
 * CEL registers its type names (`type`, `string`, `int`, `map`, `list`, ...) as
 * constants in the root namespace, and the engine registers `now` beside them. A
 * field compiled as a bare root would collide with those: a payload field named
 * `type` type-checks as the CEL type-of-type and `type == "sms"` fails to compile.
 * Nothing a user can name is a root, so nothing a user can name can collide.
 */
export const CONDITION_CONTEXT_ROOT = "payload";

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

/**
 * `incomplete` marks the failures that are an operand nobody has typed yet, as
 * opposed to a model that is broken: a blank text box, a number field holding
 * nothing, a timestamp with no amount or no date. The builder writes exactly
 * that state while a rule is half-authored, so a save may let it through where a
 * run may not.
 */
export type ConditionCompileResult =
  | { valid: true; expression: string }
  | { valid: false; error: string; incomplete?: boolean };

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
 *
 * Two rules govern where a message is attached, and both follow from Effect
 * reading the annotation off whichever node produced the issue:
 *
 * - Annotate the base type first. `.annotate()` applied to a schema that
 *   already carries a check lands on the check, and a wrong-typed value never
 *   reaches a check, so the message would go unread for exactly the input that
 *   needs it most: `Schema.Finite.annotate({ message })` answers `"5"` with
 *   Effect's own "Expected number" instead.
 * - Annotate each check separately. A check reports its own issue and reads its
 *   own annotation, so a message on a sibling check does not cover it.
 */
function requiredTextSchema(message: string) {
  return Schema.String.annotate({ message })
    .pipe(Schema.decodeTo(Schema.String, SchemaTransformation.trim()))
    .check(Schema.isMinLength(1).annotate({ message }))
    .annotateKey({ messageMissingKey: message });
}

/**
 * One message for a field, wherever the field goes wrong.
 *
 * A value of the wrong type and an absent key are different issues to Effect,
 * each reading a different annotation, and the pair has to be written together
 * or a rule that is simply missing its operator answers "Missing key". Apply
 * this to the base type: whatever is checked is checked afterwards, so that the
 * message stays on the type rather than moving onto the check.
 */
function withMessage<S extends Schema.Top>(schema: S, message: string) {
  return schema
    .annotate({ message })
    .annotateKey({ messageMissingKey: message });
}

/** The parts every rule carries, whatever kind of field it points at. */
function conditionRuleShape<TFieldType extends ConditionFieldType>(
  fieldType: TFieldType
) {
  return {
    id: requiredTextSchema("Condition id is required"),
    field: requiredTextSchema("Condition field is required"),
    fieldType: Schema.Literal(fieldType),
  };
}

/**
 * Null checks read a field's presence, so they take no operand of their own.
 *
 * The message belongs to the field type rather than to the operator pair,
 * because this is one of the arms a rule of that type can take: a timestamp
 * rule that names an operator no timestamp arm accepts has an invalid timestamp
 * operator, whichever arm noticed.
 */
function nullCheckRuleSchema<TFieldType extends ConditionFieldType>(
  fieldType: TFieldType,
  message: string
) {
  return Schema.Struct({
    ...conditionRuleShape(fieldType),
    operator: withMessage(Schema.Literals(["is_set", "is_not_set"]), message),
  });
}

const TIMESTAMP_OPERATOR_ERROR = "Timestamp operator is invalid";
const TIMESTAMP_AMOUNT_ERROR = "Timestamp amount must be a positive integer";
const DATE_TIME_ERROR =
  "Timestamp absolute operators require a valid date-time";
const STRING_OPERATOR_ERROR = "String operator is invalid";
const NUMBER_OPERATOR_ERROR = "Number operator is invalid";
const NUMBER_VALUE_ERROR = "Number conditions require a finite numeric value";
const BOOLEAN_OPERATOR_ERROR = "Boolean operator is invalid";

/**
 * Every rule shape the model admits, in one union.
 *
 * Zod described this as a union per field type, each holding a union per
 * operator. Effect picks the union members it will try by looking for a field
 * whose schema is a single literal, and takes the union of what every such
 * field selects rather than the intersection. A nested union carries no literal
 * of its own, so an outer union of unions would try every arm for every input
 * and never reach its own message. Flattened, `fieldType` selects the arms of
 * one field type and nothing else, which is the dispatch this model wants.
 *
 * The arms that carry an operand come before the null-check arm of the same
 * field type, so a rule that is missing an operand reports the missing operand
 * ahead of the null-check arm's complaint about the operator.
 */
const conditionRuleVariants = [
  Schema.Struct({
    ...conditionRuleShape("timestamp"),
    operator: withMessage(
      Schema.Literals([
        "within_next",
        "more_than_from_now",
        "less_than_ago",
        "more_than_ago",
      ]),
      TIMESTAMP_OPERATOR_ERROR
    ),
    // The checks rule out NaN and the infinities along with the fractions and
    // the non-positive counts; a count of time units has to be a real positive
    // whole number to be compiled into a CEL duration.
    // The message sits on `Schema.Number`, not on `isFinite`: a check that carries
    // the message instead would never see a wrong-typed value, which fails the
    // base type and reaches Effect's own text.
    amount: withMessage(Schema.Number, TIMESTAMP_AMOUNT_ERROR).check(
      Schema.isFinite().annotate({ message: TIMESTAMP_AMOUNT_ERROR }),
      Schema.isInt().annotate({ message: TIMESTAMP_AMOUNT_ERROR }),
      Schema.isGreaterThan(0).annotate({ message: TIMESTAMP_AMOUNT_ERROR })
    ),
    unit: withMessage(
      Schema.Literals(["minutes", "hours", "days", "weeks"]),
      "Timestamp unit is invalid"
    ),
  }),
  Schema.Struct({
    ...conditionRuleShape("timestamp"),
    operator: withMessage(
      Schema.Literals(["before", "after"]),
      TIMESTAMP_OPERATOR_ERROR
    ),
    dateTime: Schema.String.annotate({ message: DATE_TIME_ERROR })
      .pipe(Schema.decodeTo(Schema.String, SchemaTransformation.trim()))
      .check(
        Schema.makeFilter((value: string) =>
          isIsoTimestamp(value) ? undefined : DATE_TIME_ERROR
        )
      )
      .annotateKey({ messageMissingKey: DATE_TIME_ERROR }),
  }),
  nullCheckRuleSchema("timestamp", TIMESTAMP_OPERATOR_ERROR),
  Schema.Struct({
    ...conditionRuleShape("string"),
    operator: withMessage(
      Schema.Literals(["equals", "not_equals", "contains"]),
      STRING_OPERATOR_ERROR
    ),
    value: withMessage(Schema.String, "String conditions require a text value"),
  }),
  nullCheckRuleSchema("string", STRING_OPERATOR_ERROR),
  Schema.Struct({
    ...conditionRuleShape("number"),
    operator: withMessage(
      Schema.Literals([
        "equals",
        "not_equals",
        "greater_than",
        "greater_or_equal",
        "less_than",
        "less_or_equal",
      ]),
      NUMBER_OPERATOR_ERROR
    ),
    // The check rules out NaN and the infinities, leaving the finite numbers a
    // comparison can be compiled against.
    // The message sits on `Schema.Number`, not on `isFinite`: a check that carries
    // the message instead would never see a wrong-typed value, which fails the
    // base type and reaches Effect's own text.
    value: withMessage(Schema.Number, NUMBER_VALUE_ERROR).check(
      Schema.isFinite().annotate({ message: NUMBER_VALUE_ERROR })
    ),
  }),
  nullCheckRuleSchema("number", NUMBER_OPERATOR_ERROR),
  Schema.Struct({
    ...conditionRuleShape("boolean"),
    operator: withMessage(
      Schema.Literals(["is_true", "is_false"]),
      BOOLEAN_OPERATOR_ERROR
    ),
  }),
  nullCheckRuleSchema("boolean", BOOLEAN_OPERATOR_ERROR),
] as const;

/**
 * A rule has to be an object before its field type can be read, and the gate in
 * front of the union is what lets a rule that is a string or an array say so.
 */
const conditionRuleSchema = Schema.Record(Schema.String, Schema.Unknown)
  .annotate({ message: "Condition must be an object" })
  .pipe(
    Schema.decodeTo(
      Schema.Union(conditionRuleVariants).annotate({
        message: "Condition field type is invalid",
      })
    )
  );

const GROUP_CONDITIONS_ERROR = "Each group must contain at least one condition";

const conditionGroupSchema = Schema.Struct({
  id: requiredTextSchema("Group id is required"),
  logic: withMessage(Schema.Literals(["and", "or"]), "Group logic is invalid"),
  conditions: withMessage(
    Schema.mutable(Schema.Array(conditionRuleSchema)),
    GROUP_CONDITIONS_ERROR
  ).check(Schema.isMinLength(1).annotate({ message: GROUP_CONDITIONS_ERROR })),
}).annotate({ message: "Group must be an object" });

const MODEL_GROUPS_ERROR = "Condition model must contain at least one group";

const conditionModelSchema = Schema.Struct({
  version: withMessage(Schema.Literal(2), "Condition model version must be 2"),
  groupLogic: withMessage(
    Schema.Literals(["and", "or"]),
    "Condition model group logic is invalid"
  ),
  groups: withMessage(
    Schema.mutable(Schema.Array(conditionGroupSchema)),
    MODEL_GROUPS_ERROR
  ).check(Schema.isMinLength(1).annotate({ message: MODEL_GROUPS_ERROR })),
}).annotate({ message: "Condition model must be an object" });

const decodeConditionModel = Schema.decodeUnknownResult(conditionModelSchema);
const formatConditionIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * The one issue worth showing out of everything a failed decode reported.
 *
 * Effect tries every union arm whose `fieldType` matches and reports what each
 * of them made of the rule, so a rule that names an operator only one arm
 * accepts still draws a complaint from every sibling arm about that operator.
 * The arm that recognised the operator is the one Zod's discriminated union
 * would have picked, and it is the only arm that did not complain about
 * `operator` -- so an operator issue is worth reporting only when it is all
 * there is, which is when the operator really is one no arm accepts.
 */
type FormattedIssue = ReturnType<
  typeof formatConditionIssues
>["issues"][number];

/**
 * The key an issue points at. Standard Schema allows a path segment to be
 * either the key itself or an object wrapping it; Effect only ever writes the
 * first form, and this reads both so the narrowing costs nothing.
 */
function issueLeafKey(issue: FormattedIssue): PropertyKey | undefined {
  const segment = issue.path?.at(-1);
  if (segment === null || segment === undefined) {
    return undefined;
  }

  return typeof segment === "object" ? segment.key : segment;
}

function selectReportedIssue(
  issues: readonly FormattedIssue[]
): string | undefined {
  const specific = issues.find((issue) => issueLeafKey(issue) !== "operator");

  return (specific ?? issues[0])?.message;
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

  const model = decodeConditionModel(parsed);
  if (Result.isFailure(model)) {
    const { issues } = formatConditionIssues(model.failure.issue);
    return {
      valid: false,
      error: selectReportedIssue(issues) ?? "Condition model is invalid",
    };
  }

  return { valid: true, model: model.success };
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

/**
 * The model reconciled against the fields available upstream right now.
 *
 * A rule stores the type of the field it was built against, because the
 * operators and the value editor differ per type. Editing the graph upstream
 * can change that type under a rule that is already stored, and a rule holding
 * a number operator against what is now a string is not answerable. Such a rule
 * is rebuilt at its type's default, keeping its id so the row does not jump.
 *
 * Returns `model` itself when nothing changed. Callers reconcile during render,
 * so identity is what stops it from looking like an edit on every pass.
 */
export function reconcileModelWithFields(
  model: ConditionModel,
  fieldsByPath: ReadonlyMap<string, ConditionFieldDefinition>
): ConditionModel {
  let changed = false;

  const groups = model.groups.map((group) => ({
    ...group,
    conditions: group.conditions.map((condition) => {
      const field = fieldsByPath.get(condition.field);
      if (!field || field.type === condition.fieldType) {
        return condition;
      }

      changed = true;
      return createDefaultConditionRule(field, condition.id);
    }),
  }));

  return changed ? { ...model, groups } : model;
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
        incomplete: true,
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
      incomplete: true,
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
  // An unfilled text box is a rule the user has not finished, not a comparison
  // against the empty string. `is_set` and `is_not_set` cover presence.
  if (!rule.value.trim()) {
    return {
      valid: false,
      error: "Text conditions require a value",
      incomplete: true,
    };
  }

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
      incomplete: true,
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
  const path = rule.field.trim();
  if (!path) {
    return { valid: false, error: "Condition field is required" };
  }

  // A rule stores the path as the field picker offered it, relative to the node
  // output. The root belongs to the expression, not the model.
  const field = `${CONDITION_CONTEXT_ROOT}.${path}`;

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

/**
 * The same compile for a caller holding the stored string rather than a model.
 *
 * A Wait Subscription's match is kept serialized, and both the save rule and the
 * run-blocking rule have to ask the same question of it.
 */
export function compileSerializedConditionModel(
  serialized: string
): ConditionCompileResult {
  const parsed = parseConditionModel(serialized);
  if (!parsed.valid) {
    return { valid: false, error: parsed.error };
  }

  return compileConditionModel(parsed.model);
}
