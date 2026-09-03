/**
 * The model-facing condition shape and its conversion to the stored model.
 *
 * Condition nodes, Lifecycle filters, and Wait matches all use this reader so
 * every authoring surface accepts the same operators and open-record keys.
 */

import { Schema } from "effect";
import { nanoid } from "nanoid";
import { compileConditionModel } from "@wfgraph/shared/conditions/condition-compile";
import type {
  ConditionFieldType,
  ConditionGroup,
  ConditionModel,
  ConditionRule,
  GroupLogic,
} from "@wfgraph/shared/conditions/condition-model";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { isBlank } from "@wfgraph/shared/types/string";

export const conditionRuleSchema = Schema.Struct({
  field: Schema.String.annotate({
    description:
      'The payload or reference path, such as "score". Do not include a template token or node prefix.',
  }),
  recordKey: Schema.optionalKey(Schema.String).annotate({
    description:
      "The key under field when list_events or list_references marks that field as an open record.",
  }),
  fieldType: Schema.Literals([
    "string",
    "number",
    "boolean",
    "timestamp",
  ]).annotate({
    description: "The type of the value at that path.",
  }),
  operator: Schema.String.annotate({
    description:
      "string: equals, not_equals, contains. number: equals, not_equals, greater_than, greater_or_equal, less_than, less_or_equal. boolean: is_true, is_false. timestamp: within_next, more_than_from_now, less_than_ago, more_than_ago, before, after. Any type also takes is_set and is_not_set.",
  }),
  value: Schema.optionalKey(Schema.String).annotate({
    description:
      "The value compared against, for a string or number operator. A number is written as digits.",
  }),
  amount: Schema.optionalKey(Schema.Number).annotate({
    description: "How many units, for a relative timestamp operator.",
  }),
  unit: Schema.optionalKey(
    Schema.Literals(["minutes", "hours", "days", "weeks"])
  ).annotate({
    description: "The unit of amount, for a relative timestamp operator.",
  }),
  dateTime: Schema.optionalKey(Schema.String).annotate({
    description: "An ISO timestamp, for the before and after operators.",
  }),
});

export const conditionGroupsSchema = Schema.Array(
  Schema.Struct({
    logic: Schema.optionalKey(Schema.Literals(["and", "or"])).annotate({
      description: "How this group's rules combine. Defaults to and.",
    }),
    rules: Schema.Array(conditionRuleSchema),
  })
).annotate({
  description: "At least one group, each holding at least one rule.",
});

export type ConditionRuleInput = {
  readonly field: string;
  readonly recordKey?: string | undefined;
  readonly fieldType: ConditionFieldType;
  readonly operator: string;
  readonly value?: string | undefined;
  readonly amount?: number | undefined;
  readonly unit?: "minutes" | "hours" | "days" | "weeks" | undefined;
  readonly dateTime?: string | undefined;
};

export type ConditionGroupsInput = readonly {
  readonly logic?: GroupLogic | undefined;
  readonly rules: readonly ConditionRuleInput[];
}[];

type RuleReading =
  | { readonly ok: true; readonly rule: ConditionRule }
  | { readonly ok: false; readonly reason: string };

type RuleBase =
  | { readonly id: string; readonly field: string }
  | { readonly id: string; readonly field: string; readonly recordKey: string };

function readStringRule(
  base: RuleBase,
  input: ConditionRuleInput
): RuleReading {
  if (
    input.operator !== "equals" &&
    input.operator !== "not_equals" &&
    input.operator !== "contains"
  ) {
    return {
      ok: false,
      reason: `${input.operator} is not a string operator. Use equals, not_equals, contains, is_set or is_not_set.`,
    };
  }
  if (input.value === undefined) {
    return {
      ok: false,
      reason: `The ${input.operator} operator on ${input.field} needs a value.`,
    };
  }
  return {
    ok: true,
    rule: {
      ...base,
      fieldType: "string",
      operator: input.operator,
      value: input.value,
    },
  };
}

const NUMBER_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
] as const;

function readNumberRule(
  base: RuleBase,
  input: ConditionRuleInput
): RuleReading {
  const operator = NUMBER_OPERATORS.find(
    (candidate) => candidate === input.operator
  );
  if (!operator) {
    return {
      ok: false,
      reason: `${input.operator} is not a number operator. Use ${NUMBER_OPERATORS.join(", ")}, is_set or is_not_set.`,
    };
  }

  const value = Number(input.value);
  if (
    input.value === undefined ||
    isBlank(input.value) ||
    !Number.isFinite(value)
  ) {
    return {
      ok: false,
      reason: `The ${input.operator} operator on ${input.field} needs a numeric value.`,
    };
  }
  return { ok: true, rule: { ...base, fieldType: "number", operator, value } };
}

function readBooleanRule(
  base: RuleBase,
  input: ConditionRuleInput
): RuleReading {
  if (input.operator !== "is_true" && input.operator !== "is_false") {
    return {
      ok: false,
      reason: `${input.operator} is not a boolean operator. Use is_true, is_false, is_set or is_not_set.`,
    };
  }
  return {
    ok: true,
    rule: { ...base, fieldType: "boolean", operator: input.operator },
  };
}

const RELATIVE_TIMESTAMP_OPERATORS = [
  "within_next",
  "more_than_from_now",
  "less_than_ago",
  "more_than_ago",
] as const;

function readTimestampRule(
  base: RuleBase,
  input: ConditionRuleInput
): RuleReading {
  if (input.operator === "before" || input.operator === "after") {
    return input.dateTime === undefined
      ? {
          ok: false,
          reason: `The ${input.operator} operator on ${input.field} needs dateTime.`,
        }
      : {
          ok: true,
          rule: {
            ...base,
            fieldType: "timestamp",
            operator: input.operator,
            dateTime: input.dateTime,
          },
        };
  }

  const operator = RELATIVE_TIMESTAMP_OPERATORS.find(
    (candidate) => candidate === input.operator
  );
  if (!operator) {
    return {
      ok: false,
      reason: `${input.operator} is not a timestamp operator. Use ${RELATIVE_TIMESTAMP_OPERATORS.join(", ")}, before, after, is_set or is_not_set.`,
    };
  }
  if (input.amount === undefined || input.unit === undefined) {
    return {
      ok: false,
      reason: `The ${input.operator} operator on ${input.field} needs amount and unit.`,
    };
  }
  return {
    ok: true,
    rule: {
      ...base,
      fieldType: "timestamp",
      operator,
      amount: input.amount,
      unit: input.unit,
    },
  };
}

const RULE_READERS: Record<
  ConditionFieldType,
  (base: RuleBase, input: ConditionRuleInput) => RuleReading
> = {
  string: readStringRule,
  number: readNumberRule,
  boolean: readBooleanRule,
  timestamp: readTimestampRule,
};

function readRule(input: ConditionRuleInput): RuleReading {
  const base =
    input.recordKey === undefined
      ? { id: nanoid(), field: input.field }
      : { id: nanoid(), field: input.field, recordKey: input.recordKey };

  if (input.operator === "is_set" || input.operator === "is_not_set") {
    return {
      ok: true,
      rule: { ...base, fieldType: input.fieldType, operator: input.operator },
    };
  }

  return RULE_READERS[input.fieldType](base, input);
}

type ConditionModelInput = {
  readonly subject: string;
  readonly groupLogic?: GroupLogic | undefined;
  readonly groups: ConditionGroupsInput;
};

type ConditionModelReading =
  | { readonly ok: true; readonly model: ConditionModel }
  | { readonly ok: false; readonly reason: string };

function readConditionModelShape(
  input: ConditionModelInput
): ConditionModelReading {
  if (input.groups.length === 0) {
    return {
      ok: false,
      reason: `${input.subject} needs at least one group.`,
    };
  }

  const groups: ConditionGroup[] = [];
  for (const group of input.groups) {
    if (group.rules.length === 0) {
      return {
        ok: false,
        reason: `Every ${input.subject.toLowerCase()} group needs at least one rule.`,
      };
    }

    const rules: ConditionRule[] = [];
    for (const rule of group.rules) {
      const reading = readRule(rule);
      if (!reading.ok) {
        return reading;
      }
      rules.push(reading.rule);
    }
    groups.push({
      id: nanoid(),
      logic: group.logic ?? "and",
      conditions: rules,
    });
  }

  return {
    ok: true,
    model: {
      version: 2,
      groupLogic: input.groupLogic ?? "and",
      groups,
    },
  };
}

export function readConditionModelInput(input: ConditionModelInput):
  | {
      readonly ok: true;
      readonly model: ConditionModel;
      readonly expression: string;
    }
  | { readonly ok: false; readonly reason: string } {
  const reading = readConditionModelShape(input);
  if (!reading.ok) {
    return reading;
  }

  const compiled = compileConditionModel(reading.model);
  return compiled.valid
    ? { ok: true, model: reading.model, expression: compiled.expression }
    : { ok: false, reason: compiled.error };
}

/** Reads a Wait match, whose timestamp operands can resolve when the run parks. */
export function readWaitMatchModelInput(
  input: ConditionModelInput
): ConditionModelReading {
  const reading = readConditionModelShape(input);
  if (!reading.ok) {
    return reading;
  }

  const compiled = compileConditionModel(reading.model);
  if (compiled.valid) {
    return reading;
  }

  let replacedReference = false;
  const modelWithResolvedTimestamps: ConditionModel = {
    ...reading.model,
    groups: reading.model.groups.map((group) => ({
      ...group,
      conditions: group.conditions.map((rule) => {
        if (
          rule.fieldType !== "timestamp" ||
          (rule.operator !== "before" && rule.operator !== "after")
        ) {
          return rule;
        }
        const tokens = findTemplateTokens(rule.dateTime);
        if (tokens.length !== 1 || tokens[0]?.raw !== rule.dateTime) {
          return rule;
        }
        replacedReference = true;
        return { ...rule, dateTime: "2000-01-01T00:00:00Z" };
      }),
    })),
  };
  if (
    replacedReference &&
    compileConditionModel(modelWithResolvedTimestamps).valid
  ) {
    return reading;
  }

  return { ok: false, reason: compiled.error };
}
