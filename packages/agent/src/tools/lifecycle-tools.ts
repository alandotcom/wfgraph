/**
 * The two tools that write the declarations a plain config patch cannot express.
 *
 * The Lifecycle Rules decide when a run starts and when it is cancelled, and
 * they live on the entry node, which this tool creates when the workflow has
 * none. A Condition is stored twice, as the structured model the editor edits
 * and as the CEL expression the engine evaluates, and both are written here from
 * one call so they cannot disagree.
 */

import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { nanoid } from "nanoid";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { findEvent } from "@wfgraph/shared/extensions/catalog";
// The barrel keeps a historical import path and leaves these two types out, so
// the types come from the module that owns them and the functions from theirs.
import { compileConditionModel } from "@wfgraph/shared/conditions/condition-compile";
import type {
  ConditionFieldType,
  ConditionGroup,
  ConditionModel,
  ConditionRule,
  GroupLogic,
} from "@wfgraph/shared/conditions/condition-model";
import { EVENT_NAME_FIELD_PATH } from "@wfgraph/shared/conditions/condition-model";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  checkLifecycleRules,
  emptyLifecycleRules,
  type LifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { WorkflowDraft } from "#src/document";
import { referencesForNode } from "#src/tools/reference-tools";

const failureSchema = Schema.Struct({ reason: Schema.String });
const writeResultSchema = Schema.Struct({ summary: Schema.String });
const lifecycleWriteResultSchema = Schema.Struct({
  nodeId: Schema.String,
  summary: Schema.String,
});

const UNPLACED = { x: 0, y: 0 };

export const SetLifecycleRules = Tool.make("set_lifecycle_rules", {
  description:
    "Declare when a run starts and when it is cancelled. Creates the Lifecycle Node if the workflow has none. Every Event name must come from list_events.",
  parameters: Schema.Struct({
    startEvents: Schema.Array(Schema.String).annotate({
      description:
        "The Events that start a run. Empty means no Event starts it, in which case allowManualStart has to be true.",
    }),
    cancelEvents: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
      description:
        "The Events that route an in-flight run to the Canceled outlet.",
    }),
    concurrency: Schema.optionalKey(
      Schema.Literals(["newest-wins", "first-wins", "unlimited"])
    ).annotate({
      description:
        "How many runs may exist per correlated entity. newest-wins ends the run already going, first-wins refuses the new one, unlimited allows both. Defaults to unlimited.",
    }),
    allowManualStart: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Whether the Run button and the execute route may start it.",
    }),
    // A list rather than a record, for the reason `configBagSchema` in
    // graph-write-tools.ts states: a record cannot survive the round trip
    // through a strict function schema.
    correlationPaths: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          event: Schema.String.annotate({
            description: "The Event name, from list_events.",
          }),
          path: Schema.String.annotate({
            description:
              "The payload path identifying the entity a run is about, for example applicantId.",
          }),
        })
      )
    ).annotate({
      description:
        "Where each Event carries the id of the thing a run is about. Concurrency and cancellation both need it.",
    }),
  }),
  success: lifecycleWriteResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

const conditionRuleSchema = Schema.Struct({
  field: Schema.String.annotate({
    description:
      'The path property exactly as list_references reported it, such as "score". The token and its node prefix are separate fields and do not belong here.',
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

export const SetCondition = Tool.make("set_condition", {
  description:
    "Write the test a Condition step branches on. Groups are joined by groupLogic and the rules inside a group by that group's logic. Call list_references first so every field path is one the step can actually read.",
  parameters: Schema.Struct({
    nodeId: Schema.String.annotate({
      description: "The Condition node to write, from read_workflow.",
    }),
    groupLogic: Schema.optionalKey(Schema.Literals(["and", "or"])).annotate({
      description: "How the groups combine. Defaults to and.",
    }),
    groups: Schema.Array(
      Schema.Struct({
        logic: Schema.optionalKey(Schema.Literals(["and", "or"])).annotate({
          description: "How this group's rules combine. Defaults to and.",
        }),
        rules: Schema.Array(conditionRuleSchema),
      })
    ).annotate({
      description: "At least one group, each holding at least one rule.",
    }),
  }),
  success: writeResultSchema,
  failure: failureSchema,
  failureMode: "return",
});

type RuleInput = {
  readonly field: string;
  readonly fieldType: ConditionFieldType;
  readonly operator: string;
  readonly value?: string | undefined;
  readonly amount?: number | undefined;
  readonly unit?: "minutes" | "hours" | "days" | "weeks" | undefined;
  readonly dateTime?: string | undefined;
};

type RuleReading =
  | { readonly ok: true; readonly rule: ConditionRule }
  | { readonly ok: false; readonly reason: string };

type RuleBase = { readonly id: string; readonly field: string };

function readStringRule(base: RuleBase, input: RuleInput): RuleReading {
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

function readNumberRule(base: RuleBase, input: RuleInput): RuleReading {
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
    input.value.trim().length === 0 ||
    !Number.isFinite(value)
  ) {
    return {
      ok: false,
      reason: `The ${input.operator} operator on ${input.field} needs a numeric value.`,
    };
  }
  return { ok: true, rule: { ...base, fieldType: "number", operator, value } };
}

function readBooleanRule(base: RuleBase, input: RuleInput): RuleReading {
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

function readTimestampRule(base: RuleBase, input: RuleInput): RuleReading {
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

/**
 * A reader per field type, which is what makes the set exhaustive: adding a
 * `ConditionFieldType` stops this record compiling until it has a reader.
 */
const RULE_READERS: Record<
  ConditionFieldType,
  (base: RuleBase, input: RuleInput) => RuleReading
> = {
  string: readStringRule,
  number: readNumberRule,
  boolean: readBooleanRule,
  timestamp: readTimestampRule,
};

/**
 * One rule, read out of the flat shape the model fills in.
 *
 * The stored model is a discriminated union, and a union is a poor thing to ask
 * a model to fill in; a flat struct with the wrong combination refused by name
 * is the trade. Every refusal says which field was missing for which operator,
 * so the next call can be right.
 */
function readRule(input: RuleInput): RuleReading {
  const base: RuleBase = { id: nanoid(), field: input.field };

  // Either null check reads the same whatever the field holds.
  if (input.operator === "is_set" || input.operator === "is_not_set") {
    return {
      ok: true,
      rule: { ...base, fieldType: input.fieldType, operator: input.operator },
    };
  }

  return RULE_READERS[input.fieldType](base, input);
}

/** The entry node, or a fresh one when the workflow has never had rules. */
function entryNodeOf(nodes: readonly WorkflowNode[]): WorkflowNode {
  const existing = nodes.find((node) => node.data.type === "lifecycle");
  return (
    existing ?? {
      id: nanoid(),
      position: UNPLACED,
      type: "lifecycle",
      data: { label: "Lifecycle", type: "lifecycle", config: {} },
    }
  );
}

export const lifecycleToolHandlers = Effect.gen(function* () {
  const draft = yield* WorkflowDraft;

  return {
    set_lifecycle_rules: (input: {
      readonly startEvents: readonly string[];
      readonly cancelEvents?: readonly string[] | undefined;
      readonly concurrency?:
        | "newest-wins"
        | "first-wins"
        | "unlimited"
        | undefined;
      readonly allowManualStart?: boolean | undefined;
      readonly correlationPaths?:
        | readonly { readonly event: string; readonly path: string }[]
        | undefined;
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const named = [...input.startEvents, ...(input.cancelEvents ?? [])];
        const unknown = named.filter(
          (name) => findEvent(draft.catalog, name) === undefined
        );
        if (unknown.length > 0) {
          return Effect.fail({
            reason: `No Event named ${unknown.join(", ")}. Call list_events to see what the host registered.`,
          });
        }

        if (input.startEvents.length === 0 && input.allowManualStart !== true) {
          return Effect.fail({
            reason:
              "A workflow needs a way to start. Name at least one Start Event, or set allowManualStart to true.",
          });
        }

        const rules: LifecycleRules = {
          ...emptyLifecycleRules,
          startEvents: [...input.startEvents],
          cancelEvents: [...(input.cancelEvents ?? [])],
          ...(input.concurrency === undefined
            ? {}
            : { concurrency: input.concurrency }),
          ...(input.allowManualStart === undefined
            ? {}
            : { allowManualStart: input.allowManualStart }),
          ...(input.correlationPaths === undefined
            ? {}
            : {
                correlationPaths: Object.fromEntries(
                  input.correlationPaths.map((entry) => [
                    entry.event,
                    entry.path,
                  ])
                ),
              }),
        };

        const check = checkLifecycleRules({ rules, catalog: draft.catalog });
        if (!check.valid) {
          return Effect.fail({ reason: check.error });
        }

        const entry = entryNodeOf(document.nodes);
        const created = !document.nodes.some((node) => node.id === entry.id);
        const updated: WorkflowNode = {
          ...entry,
          data: {
            ...entry.data,
            config: { ...entry.data.config, lifecycleRules: rules },
          },
        };

        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: created
              ? [updated, ...current.nodes]
              : current.nodes.map((node) =>
                  node.id === entry.id ? updated : node
                ),
          })),
          {
            nodeId: entry.id,
            summary: `${created ? "Created the Lifecycle Node and set" : "Set"} the rules: starts on ${rules.startEvents.join(", ") || "manual start only"}.`,
          }
        );
      }),

    set_condition: (input: {
      readonly nodeId: string;
      readonly groupLogic?: GroupLogic | undefined;
      readonly groups: readonly {
        readonly logic?: GroupLogic | undefined;
        readonly rules: readonly RuleInput[];
      }[];
    }) =>
      Effect.flatMap(draft.current, (document) => {
        const node = document.nodes.find(
          (candidate) => candidate.id === input.nodeId
        );
        if (!node) {
          return Effect.fail({ reason: `No node with id ${input.nodeId}.` });
        }
        if (actionTypeOf(node) !== BUILT_IN_ACTION_IDS.condition) {
          return Effect.fail({
            reason: `${input.nodeId} is not a Condition step, so it has no test to write.`,
          });
        }
        if (input.groups.length === 0) {
          return Effect.fail({
            reason: "A condition needs at least one group.",
          });
        }

        const availableReferences =
          referencesForNode({
            nodeId: input.nodeId,
            document,
            catalog: draft.catalog,
          }) ?? [];
        const availablePaths = new Set(
          availableReferences.map((reference) => reference.path)
        );

        const groups: ConditionGroup[] = [];
        for (const group of input.groups) {
          if (group.rules.length === 0) {
            return Effect.fail({
              reason: "Every group needs at least one rule.",
            });
          }

          const rules: ConditionRule[] = [];
          for (const rule of group.rules) {
            if (
              rule.field !== EVENT_NAME_FIELD_PATH &&
              availablePaths.size === 0
            ) {
              return Effect.fail({
                reason:
                  "This Condition has no available references. Connect its inputs, then call list_references.",
              });
            }
            if (
              rule.field !== EVENT_NAME_FIELD_PATH &&
              !availablePaths.has(rule.field)
            ) {
              return Effect.fail({
                reason: `That condition field is unavailable. Use the path property from list_references: ${[...availablePaths].join(", ")}.`,
              });
            }
            const expectedTypes = new Set<ConditionFieldType>(
              rule.field === EVENT_NAME_FIELD_PATH
                ? ["string"]
                : availableReferences
                    .filter((reference) => reference.path === rule.field)
                    .flatMap((reference) => reference.conditionFieldType ?? [])
            );
            if (expectedTypes.size !== 1) {
              return Effect.fail({
                reason:
                  "That reference does not have one condition-compatible type.",
              });
            }
            const [expectedType] = expectedTypes;
            if (rule.fieldType !== expectedType) {
              return Effect.fail({
                reason: `Use fieldType ${expectedType} for ${rule.field}, as list_references reports.`,
              });
            }
            const reading = readRule(rule);
            if (!reading.ok) {
              return Effect.fail({ reason: reading.reason });
            }
            rules.push(reading.rule);
          }

          groups.push({
            id: nanoid(),
            logic: group.logic ?? "and",
            conditions: rules,
          });
        }

        const model: ConditionModel = {
          version: 2,
          groupLogic: input.groupLogic ?? "and",
          groups,
        };

        const compiled = compileConditionModel(model);
        if (!compiled.valid) {
          return Effect.fail({ reason: compiled.error });
        }

        // The model and the CEL it compiles to are one fact about the node, so
        // they are written together; the editor writes them the same way.
        const updated: WorkflowNode = {
          ...node,
          data: {
            ...node.data,
            config: {
              ...node.data.config,
              conditionModel: serializeConditionModel(model),
              condition: compiled.expression,
            },
          },
        };

        return Effect.as(
          draft.update((current) => ({
            ...current,
            nodes: current.nodes.map((candidate) =>
              candidate.id === input.nodeId ? updated : candidate
            ),
          })),
          { summary: `Set the test on ${node.data.label || input.nodeId}.` }
        );
      }),
  };
});
