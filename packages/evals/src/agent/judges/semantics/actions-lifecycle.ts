import { compact } from "es-toolkit/array";
import { isEqual } from "es-toolkit/predicate";
import type { ConditionModel } from "@wfgraph/shared/conditions/condition-model";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import type { LifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import {
  checkEach,
  type SemanticsContext,
} from "#src/agent/judges/semantics/context";
import type { EvalLifecycleFilter } from "#src/agent/types";

function actionNodeCount(count: number, actionId: string): string {
  return `${count} ${actionId} node${count === 1 ? "" : "s"}`;
}

function wrongExactActionCounts(context: SemanticsContext): string[] {
  const exactActions = context.input.expected.exactActions;
  if (exactActions === undefined) {
    return [];
  }
  const expectedCounts = new Map(Object.entries(exactActions));
  const wrongCounts = checkEach(
    [...expectedCounts.entries()],
    ([actionId, expectedCount]) => {
      const actualCount = context.actionCounts.get(actionId) ?? 0;
      return actualCount === expectedCount
        ? undefined
        : `Expected exactly ${actionNodeCount(expectedCount, actionId)}, found ${actualCount}`;
    }
  );
  const unexpectedActions = [...context.actionCounts.keys()].flatMap(
    (actionId) =>
      expectedCounts.has(actionId)
        ? []
        : [`unexpected action ${actionId} is present`]
  );
  return [...wrongCounts, ...unexpectedActions];
}

function exactEventSetFailure(input: {
  kind: "Start" | "Cancel";
  expected: readonly string[];
  actual: readonly string[];
}): string | undefined {
  const expected = new Set(input.expected);
  const actual = new Set(input.actual);
  const matches =
    expected.size === actual.size &&
    [...expected].every((event) => actual.has(event));
  if (matches) {
    return undefined;
  }
  const expectedText =
    input.expected.length === 0 ? "none" : input.expected.join(", ");
  const actualText =
    input.actual.length === 0 ? "none" : input.actual.join(", ");
  return `${input.kind} Events must be exactly ${expectedText}, found ${actualText}`;
}

function wrongExactEvents(context: SemanticsContext): string[] {
  const exactEvents = context.input.expected.exactEvents;
  if (exactEvents === undefined) {
    return [];
  }
  return compact([
    exactEventSetFailure({
      kind: "Start",
      expected: exactEvents.start,
      actual: context.lifecycleRules.flatMap(
        (rules) => rules?.startEvents ?? []
      ),
    }),
    exactEventSetFailure({
      kind: "Cancel",
      expected: exactEvents.cancel,
      actual: context.lifecycleRules.flatMap(
        (rules) => rules?.cancelEvents ?? []
      ),
    }),
  ]);
}

function wrongRequiredLifecycleRules(context: SemanticsContext): string[] {
  const required = context.input.expected.requiredLifecycleRules;
  if (required === undefined) {
    return [];
  }
  const rules = context.lifecycleRules.find(
    (candidate): candidate is LifecycleRules => candidate !== undefined
  );
  return compact([
    required.concurrency === undefined ||
    rules?.concurrency === required.concurrency
      ? undefined
      : `Lifecycle concurrency must be ${required.concurrency}`,
    required.allowManualStart === undefined ||
    rules?.allowManualStart === required.allowManualStart
      ? undefined
      : `Lifecycle manual start must be ${required.allowManualStart ? "enabled" : "disabled"}`,
    required.correlationPaths === undefined ||
    includesRequiredEntries(rules?.correlationPaths, required.correlationPaths)
      ? undefined
      : "Lifecycle Correlation Paths do not include the required values",
    required.connectionIds === undefined ||
    includesRequiredEntries(rules?.connectionIds, required.connectionIds)
      ? undefined
      : "Lifecycle Connections do not include the required values",
  ]);
}

function includesRequiredEntries(
  actual: Readonly<Record<string, string>> | undefined,
  required: Readonly<Record<string, string>>
): boolean {
  return Object.entries(required).every(
    ([key, value]) =>
      actual !== undefined &&
      Object.hasOwn(actual, key) &&
      actual[key] === value
  );
}

function lifecycleFilterShape(model: ConditionModel) {
  return {
    groupLogic: model.groupLogic,
    groups: model.groups.map((group) => ({
      logic: group.logic,
      rules: group.conditions.map(({ id: _id, ...rule }) => rule),
    })),
  };
}

function missingLifecycleFilters(input: {
  context: SemanticsContext;
  requiredFilters: readonly EvalLifecycleFilter[] | undefined;
  filtersOf: (rules: LifecycleRules) => Record<string, string> | undefined;
  label: "Start" | "Cancel";
}): string[] {
  return checkEach(input.requiredFilters, (required) => {
    const hasFilter = input.context.lifecycleRules
      .filter(
        (rules): rules is LifecycleRules =>
          rules !== undefined &&
          (input.label === "Start"
            ? rules.startEvents
            : rules.cancelEvents
          ).includes(required.event)
      )
      .some((rules) => {
        const parsed = parseConditionModel(
          input.filtersOf(rules)?.[required.event]
        );
        return (
          parsed.valid &&
          isEqual(lifecycleFilterShape(parsed.model), required.filter)
        );
      });
    return hasFilter
      ? undefined
      : `${required.event} does not have the exact required ${input.label} Filter`;
  });
}

function missingStartFilters(context: SemanticsContext): string[] {
  return missingLifecycleFilters({
    context,
    requiredFilters: context.input.expected.requiredStartFilters,
    filtersOf: (rules) => rules.startFilters,
    label: "Start",
  });
}

function missingCancelFilters(context: SemanticsContext): string[] {
  return missingLifecycleFilters({
    context,
    requiredFilters: context.input.expected.requiredCancelFilters,
    filtersOf: (rules) => rules.cancelFilters,
    label: "Cancel",
  });
}

/** Runs action and Lifecycle rules in rationale order. */
export function assessActionAndLifecycleSemantics(
  context: SemanticsContext
): string[] {
  return [
    ...wrongExactActionCounts(context),
    ...wrongExactEvents(context),
    ...wrongRequiredLifecycleRules(context),
    ...missingStartFilters(context),
    ...missingCancelFilters(context),
  ];
}
