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

/**
 * The CEL root holding the Event a run arrived on, beside `payload` and `now`.
 *
 * It sits outside the payload namespace because the entry node's output is the
 * payload and nothing else: a key added there would shadow a payload field of
 * the same name.
 */
export const EVENT_CONTEXT_ROOT = "event";

/**
 * The stored field path a rule names the arriving Event by.
 *
 * A rule addresses the run itself through this one path, which the compiler
 * emits as `event.name`. The `$` is what keeps the two namespaces apart: an
 * Event author declares payload paths, and none of them can open with one.
 */
export const EVENT_NAME_FIELD_PATH = "$event.name";

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
