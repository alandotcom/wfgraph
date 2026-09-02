/**
 * A Wait Subscription's match, turned from a stored model into something a
 * parked run can be woken by.
 *
 * The match is authored against two sides at once: a field of the Event that has
 * not arrived yet, compared against a value this run already holds. Only the run
 * side can be resolved while the run is here, so it is resolved at park time and
 * the comparison is compiled to a CEL string with literals in it. What the row
 * stores is JSON, which is what lets it cross the JSONB column and Inngest's
 * memoization and still mean the same thing when the Event finally arrives.
 */

import { Schema } from "effect";
import { getAppLogger } from "#src/backend/lib/logger";
import { readAs } from "@wfgraph/shared/types/schema";
import { isBlank } from "@wfgraph/shared/types/string";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  collectTimestampFieldPaths,
  compileConditionModel,
  type ConditionModel,
  type ConditionRule,
  isNullCheckConditionRule,
  isTimestampAbsoluteConditionRule,
  parseConditionModel,
  readConditionRuleOperand,
} from "@wfgraph/shared/conditions/conditions";
import type { EventSubscription } from "@wfgraph/shared/lifecycle/wait-subscription";

const logger = getAppLogger("waits");

/**
 * One subscription as the wait row holds it.
 *
 * The match is one object rather than two loose keys, because the two have to
 * travel together: a compiled string keeps no record of which of its fields are
 * timestamps, and a payload delivers one as an ISO string that CEL will not
 * compare against an instant. Nesting them makes an expression without its paths
 * unrepresentable, which matters because that combination fails silently -- the
 * wait simply never wakes, and says nothing about why until its timeout.
 *
 * A subscription with no match carries none, and resume matching reads that as
 * "the next occurrence of this Event, whatever it carries".
 */
const compiledWaitSubscriptionSchema = Schema.Struct({
  event: Schema.String,
  // The row this decodes is a stored JSONB document, so an unset key is absent
  // rather than present holding undefined. `optionalKey` says that, and it is
  // also what lets a compiled subscription be written back as a JSON value.
  connectionId: Schema.optionalKey(Schema.String),
  match: Schema.optionalKey(
    Schema.Struct({
      expression: Schema.String,
      timestampPaths: Schema.mutable(Schema.Array(Schema.String)),
    })
  ),
});

export type CompiledWaitSubscription =
  typeof compiledWaitSubscriptionSchema.Type;

const readStoredSubscriptions = readAs(
  Schema.mutable(Schema.Array(compiledWaitSubscriptionSchema))
);

/**
 * The subscriptions a parked row stored, as resume matching reads them back.
 *
 * A row carrying no `waitFor` at all is a wait on a clock, which no arriving
 * Event concerns, so an empty list is the honest answer. One carrying a `waitFor`
 * that will not decode is a row this engine wrote and cannot read: the run is
 * about to go unwoken by an Event it is a candidate for, and the empty list on
 * its own would make that look like an ordinary non-match.
 */
export function readCompiledWaitSubscriptions(
  metadata: Record<string, unknown> | null | undefined
): CompiledWaitSubscription[] {
  const stored = metadata?.waitFor;
  if (stored === undefined) {
    return [];
  }

  const subscriptions = readStoredSubscriptions(stored);
  if (!subscriptions) {
    logger.error("Parked wait holds subscriptions that will not decode");
    return [];
  }

  return subscriptions;
}

export type WaitSubscriptionCompileResult =
  | { valid: true; subscriptions: CompiledWaitSubscription[] }
  | { valid: false; error: string };

/** Replaces the `{{@nodeId:Label.field}}` references in one authored string. */
export type ResolveTemplates = (value: string) => string;

/** The run-side values inside one rule, as literals. */
function resolveRuleTemplates(
  rule: ConditionRule,
  resolveTemplates: ResolveTemplates
): ConditionRule {
  if (isNullCheckConditionRule(rule)) {
    return rule;
  }

  if (rule.fieldType === "string") {
    return { ...rule, value: resolveTemplates(rule.value) };
  }

  if (
    rule.fieldType === "timestamp" &&
    isTimestampAbsoluteConditionRule(rule)
  ) {
    return { ...rule, dateTime: resolveTemplates(rule.dateTime) };
  }

  return rule;
}

function resolveModelTemplates(
  model: ConditionModel,
  resolveTemplates: ResolveTemplates
): ConditionModel {
  return {
    ...model,
    groups: model.groups.map((group) => ({
      ...group,
      conditions: group.conditions.map((condition) =>
        resolveRuleTemplates(condition, resolveTemplates)
      ),
    })),
  };
}

/** The first operand of this model still carrying a template reference. */
function findUnresolvedReference(model: ConditionModel): string | undefined {
  for (const group of model.groups) {
    for (const rule of group.conditions) {
      const operand = readConditionRuleOperand(rule);
      if (operand?.includes("{{")) {
        return operand.trim();
      }
    }
  }

  return undefined;
}

/**
 * Every subscription this wait parks on, resolved and compiled, or the first
 * sentence saying why one of them cannot be.
 *
 * A match that will not compile fails the wait rather than parking without it.
 * Parking anyway would subscribe the run to every occurrence of that Event, which
 * is the opposite of what the builder wrote.
 */
export function compileWaitSubscriptions(input: {
  subscriptions: readonly EventSubscription[];
  resolveTemplates: ResolveTemplates;
}): WaitSubscriptionCompileResult {
  const subscriptions: CompiledWaitSubscription[] = [];

  for (const subscription of input.subscriptions) {
    const base: CompiledWaitSubscription = omitUndefined({
      event: subscription.event,
      connectionId: subscription.connectionId,
    });

    if (subscription.match === undefined || isBlank(subscription.match)) {
      subscriptions.push(base);
      continue;
    }

    const parsed = parseConditionModel(subscription.match);
    if (!parsed.valid) {
      return {
        valid: false,
        error: `Wait match for "${subscription.event}" is invalid: ${parsed.error}`,
      };
    }

    const resolved = resolveModelTemplates(
      parsed.model,
      input.resolveTemplates
    );

    // The resolver leaves a reference it cannot answer as the authored text, so
    // an operand still holding one names a node that did not run. Compiling it
    // would park the run on a comparison against the literal `{{...}}`, which no
    // payload ever equals: a wait that cannot wake, silent until its timeout.
    const unresolved = findUnresolvedReference(resolved);
    if (unresolved) {
      return {
        valid: false,
        error: `Wait match for "${subscription.event}" is invalid: ${unresolved} is not available to this run`,
      };
    }

    const compiled = compileConditionModel(resolved);
    if (!compiled.valid) {
      return {
        valid: false,
        error: `Wait match for "${subscription.event}" is invalid: ${compiled.error}`,
      };
    }

    subscriptions.push({
      ...base,
      match: {
        expression: compiled.expression,
        timestampPaths: collectTimestampFieldPaths(resolved),
      },
    });
  }

  return { valid: true, subscriptions };
}
