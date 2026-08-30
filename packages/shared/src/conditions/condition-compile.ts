import { celStringLiteral } from "#src/conditions/cel-string-literal";
import {
  CONDITION_CONTEXT_ROOT,
  EVENT_CONTEXT_ROOT,
  EVENT_CONNECTION_ID_FIELD_PATH,
  EVENT_NAME_FIELD_PATH,
  type BooleanConditionRule,
  type ConditionCompileResult,
  type ConditionGroup,
  type ConditionModel,
  type ConditionRule,
  type GroupLogic,
  type NullCheckConditionRule,
  type NumberConditionRule,
  type NumberOperator,
  type StringConditionRule,
  type TimeUnit,
  type TimestampAbsoluteConditionRule,
  type TimestampRelativeConditionRule,
  isNullCheckConditionRule,
  isTimestampRelativeConditionRule,
} from "#src/conditions/condition-model";
import { parseConditionModel } from "#src/conditions/condition-schema";
import { decodeIsoTimestamp } from "#src/types/timestamp";
import {
  parseOutputPath,
  type OutputPathStep,
} from "#src/graph/node-references";

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

function isTimeUnit(value: unknown): value is TimeUnit {
  return (
    value === "minutes" ||
    value === "hours" ||
    value === "days" ||
    value === "weeks"
  );
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

  const serializedDateTime = celStringLiteral(rule.dateTime.trim());
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

  const value = celStringLiteral(rule.value);

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

/**
 * Whether a payload carries the field at this path, as one `has` per segment.
 *
 * CEL raises rather than answering false for an absent key, and `has()` inherits
 * that for every segment but the last: `has(payload.appointment.reason)` raises
 * "No such key: appointment" where the payload holds no appointment at all. So
 * each segment is tested before the one below it, and the chain as a whole reads
 * false for a path the payload does not reach.
 */
function isCelIdentifier(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function compilePayloadPath(
  path: string
): { field: string; presence: string } | null {
  const steps = parseOutputPath(path);
  if (!steps) {
    return null;
  }

  if (
    steps.every(
      (step): step is Extract<OutputPathStep, { kind: "key" }> =>
        step.kind === "key" && isCelIdentifier(step.key)
    )
  ) {
    const keys = steps.map((step) => step.key);
    return {
      field: `${CONDITION_CONTEXT_ROOT}.${keys.join(".")}`,
      presence: keys
        .map(
          (_, index) =>
            `has(${CONDITION_CONTEXT_ROOT}.${keys.slice(0, index + 1).join(".")})`
        )
        .join(" && "),
    };
  }

  let field = CONDITION_CONTEXT_ROOT;
  const guards: string[] = [];
  for (const step of steps) {
    if (step.kind === "key") {
      const key = celStringLiteral(step.key);
      guards.push(`${key} in ${field}`);
      field = `${field}[${key}]`;
    } else {
      guards.push(`size(${field}) > ${step.index}`);
      field = `${field}[${step.index}]`;
    }
  }

  return { field, presence: guards.join(" && ") };
}

/**
 * Presence is the whole of what a null check asks, so it compiles to the chain
 * itself. `is_not_set` negates the chain entire rather than its last link, which
 * is what answers it true for a payload missing the parent object.
 */
function compileNullCheckConditionRule(
  rule: NullCheckConditionRule,
  presence: string
): ConditionCompileResult {
  if (rule.operator === "is_set") {
    return { valid: true, expression: presence };
  }

  return { valid: true, expression: `!(${presence})` };
}

function compileComparisonRule(
  rule: Exclude<ConditionRule, NullCheckConditionRule>,
  field: string
): ConditionCompileResult {
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

/**
 * A rule about the Event the run arrived on rather than about its payload.
 *
 * The root is written on every run and holds null where nothing named an Event,
 * so a comparison needs no presence guard and a null check reads as a null test.
 */
function compileEventRootRule(
  rule: ConditionRule,
  property: "name" | "connectionId"
): ConditionCompileResult {
  const field = `${EVENT_CONTEXT_ROOT}.${property}`;

  if (isNullCheckConditionRule(rule)) {
    return {
      valid: true,
      expression:
        rule.operator === "is_set" ? `${field} != null` : `${field} == null`,
    };
  }

  return compileComparisonRule(rule, field);
}

/**
 * One rule on its own, for a caller that has to answer for that rule rather
 * than for the model holding it.
 *
 * The editor's read-only summary renders a line per rule, and an unfinished one
 * has to say so there: `incomplete` on the failure is what separates a rule the
 * builder has not filled in from a model that is malformed.
 */
export function compileConditionRule(
  rule: ConditionRule
): ConditionCompileResult {
  const path = rule.field.trim();
  if (!path) {
    return { valid: false, error: "Condition field is required" };
  }

  if (path === EVENT_NAME_FIELD_PATH) {
    return compileEventRootRule(rule, "name");
  }

  if (path === EVENT_CONNECTION_ID_FIELD_PATH) {
    return compileEventRootRule(rule, "connectionId");
  }

  // A rule stores the path as the field picker offered it, relative to the node
  // output. The root belongs to the expression, not the model.
  const compiledPath = compilePayloadPath(path);
  if (!compiledPath) {
    return { valid: false, error: "Condition field path is invalid" };
  }
  const { field, presence } = compiledPath;

  if (isNullCheckConditionRule(rule)) {
    return compileNullCheckConditionRule(rule, presence);
  }

  const compiled = compileComparisonRule(rule, field);
  if (!compiled.valid) {
    return compiled;
  }

  // A rule about a field this run's payload does not carry answers false on its
  // own. Unguarded, the absent key raises instead, and CEL propagates that far
  // enough to decide the whole condition rather than this one rule.
  return {
    valid: true,
    expression: `${presence} && (${compiled.expression})`,
  };
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
