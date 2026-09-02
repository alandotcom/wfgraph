/**
 * The Start Filter: the condition an arrival must satisfy before a run opens,
 * written per Start Event (ADR-0016).
 *
 * Beside `event-connections.ts` and for the same reason. A filter is one
 * per-Event record on the Lifecycle Rules, and everything about it belongs
 * together: how a group of Start Events reads as one control, what that control
 * writes, and what a save and a publish each hold the result to.
 *
 * The rules object itself stays `lifecycle-rules.ts`'s. Nothing here decides
 * which Events start a workflow; it decides what an arrival on one has to say.
 */

import { isEmptyObject } from "es-toolkit/predicate";
import {
  compileConditionModel,
  compileSerializedConditionModel,
  type ConditionModel,
  type ConditionRule,
  EVENT_NAME_FIELD_PATH,
  isNullCheckConditionRule,
  parseConditionModel,
  readConditionRuleOperand,
} from "#src/conditions/conditions";
import { conditionTypeOf } from "#src/conditions/condition-field-type";
import { type ExtensionCatalog, findEvent } from "#src/extensions/catalog";
import {
  appendOutputPathKey,
  findTemplateTokens,
} from "#src/graph/node-references";
import {
  type LifecycleRules,
  type LifecycleRulesCheck,
  lifecycleRulesValid,
  refuseLifecycleRules,
  retainNamedKeys,
} from "#src/lifecycle/lifecycle-rules";

/**
 * Every Start Filter, read as far as a stored graph has to be readable.
 *
 * The save battery's half of the question. A model that will not parse or will
 * not compile is broken whatever the builder does next, so it is refused here; a
 * model whose operands are still blank is the ordinary state of one being
 * written, and every keystroke autosaves, so it passes. `checkStartFilters` is
 * what refuses the rest, at publish.
 *
 * Takes no catalog, which is what lets the save battery stay a pure read of the
 * graph.
 */
export function checkStartFilterModels(
  rules: LifecycleRules
): LifecycleRulesCheck {
  const read = readStartFilterModels(rules);
  return read.valid ? lifecycleRulesValid : refuseLifecycleRules(read.error);
}

/**
 * Every Start Filter parsed once, or the sentence naming the first that will
 * not parse.
 *
 * Both checks need the models rather than a verdict: the save battery asks only
 * whether they are readable, and the publish battery goes on to ask what they
 * read. Handing them back is what keeps the stricter check from parsing a second
 * time, and what stops it carrying a parse-failure branch it can never reach.
 */
function readStartFilterModels(
  rules: LifecycleRules
):
  | { valid: true; models: [string, ConditionModel][] }
  | { valid: false; error: string } {
  const models: [string, ConditionModel][] = [];

  for (const eventName of rules.startEvents) {
    const serialized = readStartFilter(rules, eventName);
    if (!serialized) {
      continue;
    }

    const parsed = parseConditionModel(serialized);
    if (!parsed.valid) {
      return {
        valid: false,
        error: `The start filter for "${eventName}" is invalid: ${parsed.error}`,
      };
    }

    // A model whose operands are still blank compiles to nothing and is the
    // ordinary state of one being written, so it is readable. Publishing is what
    // requires a finished one.
    const compiled = compileConditionModel(parsed.model);
    if (!compiled.valid && !compiled.incomplete) {
      return {
        valid: false,
        error: `The start filter for "${eventName}" is invalid: ${compiled.error}`,
      };
    }

    models.push([eventName, parsed.model]);
  }

  return { valid: true, models };
}

/**
 * Every Start Filter, held to what a run can actually be decided by.
 *
 * The publish battery's half, and a strict superset of `checkStartFilterModels`:
 * a stored graph may carry an unfinished filter, a running one may not
 * (ADR-0012), which is the same bar a Condition node's own unfinished state is
 * held to. Three further refusals sit on top, and each is a rule that would
 * otherwise fail in silence: an arrival would be measured against something that
 * cannot be measured, and the workflow would stop starting with nothing anywhere
 * saying why.
 *
 * A filter keyed to an Event that does not start this workflow is not this
 * function's; `checkLifecycleRules` refuses that, and the panel prunes it.
 */
export function checkStartFilters(input: {
  rules: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRulesCheck {
  const { rules, catalog } = input;

  const read = readStartFilterModels(rules);
  if (!read.valid) {
    return refuseLifecycleRules(read.error);
  }

  for (const [eventName, model] of read.models) {
    const compiled = compileConditionModel(model);
    if (!compiled.valid) {
      // Readable but unfinished, which the save battery admits and a run cannot.
      return refuseLifecycleRules(
        `The start filter for "${eventName}" is unfinished. Complete it, or remove it.`
      );
    }

    for (const group of model.groups) {
      for (const rule of group.conditions) {
        // A Start Filter is measured against an Event that has not arrived, so a
        // reference to a node's output has nothing to resolve from. Compiled as
        // written it would compare against the literal token text, which no
        // payload equals: a workflow that never starts and never says why.
        //
        // Read with the template grammar rather than by looking for `{{`, so a
        // payload value that merely contains braces stays filterable.
        const operand = readConditionRuleOperand(rule);
        if (operand && findTemplateTokens(operand).length > 0) {
          return refuseLifecycleRules(
            `The start filter for "${eventName}" refers to a value from a run. A start filter is read before a run exists, so it can only compare payload fields against literals.`
          );
        }
      }
    }

    const unreadable = unreadableFilterRule({ model, catalog, eventName });
    if (unreadable) {
      return refuseLifecycleRules(
        `The start filter for "${eventName}" ${unreadable}. Rebuild the rule against a field "${eventName}" declares, or filter each Event separately.`
      );
    }
  }

  return lifecycleRulesValid;
}

/**
 * How the Start Filters of a rules object read as one group.
 *
 * `collapsed` means every Start Event holds the same answer, so one editor can
 * stand for all of them: either they all carry the identical model, or none of
 * them carries one. A group whose Events disagree has to be shown one Event at a
 * time, because no single control could say what it holds.
 *
 * Derived rather than stored, for the reason `readWaitDelayTiming` derives a Wait
 * node's timing: a stored flag and the values it describes can disagree, and then
 * the panel draws a control over a rule nobody wrote.
 */
export type StartFilterLayout =
  | { collapsed: true; model?: string }
  | { collapsed: false };

/** The Start Filter stored for one Event, absent when it has none. */
export function readStartFilter(
  rules: LifecycleRules,
  eventName: string
): string | undefined {
  return rules.startFilters?.[eventName]?.trim() || undefined;
}

/**
 * What two Start Filters have to match on to count as the same rule.
 *
 * The compiled CEL, rather than the stored model, because the model carries the
 * group and rule ids the builder's editor generated. Two Events given the same
 * rule separately hold different ids and identical meaning, and comparing the
 * stored text would call those two rules and never offer the group back to one
 * control. A model that does not compile has no expression to compare, and is
 * then the same as another only by being the same text.
 */
function startFilterIdentity(
  serialized: string | undefined
): string | undefined {
  if (!serialized) {
    return undefined;
  }

  const compiled = compileSerializedConditionModel(serialized);
  return compiled.valid ? compiled.expression : serialized;
}

/** Whether one control can stand for every Start Event's filter. See `StartFilterLayout`. */
export function readStartFilterLayout(
  rules: LifecycleRules
): StartFilterLayout {
  const stored = rules.startEvents.map((eventName) =>
    readStartFilter(rules, eventName)
  );

  if (new Set(stored.map(startFilterIdentity)).size > 1) {
    return { collapsed: false };
  }

  // They agree, so the first filter any Start Event holds stands for all of
  // them, and an edit through the collapsed control writes one model to every
  // Event regardless. None of them holding one is agreement too, and the control
  // opens empty. So is a workflow with no Start Events at all.
  const model = stored.find((filter) => filter !== undefined);
  return model ? { collapsed: true, model } : { collapsed: true };
}

function writeStartFilters(
  rules: LifecycleRules,
  filters: Record<string, string>
): LifecycleRules {
  return {
    ...rules,
    startFilters: isEmptyObject(filters) ? undefined : filters,
  };
}

/** One Event's Start Filter, written or cleared. */
export function setStartFilterForEvent(input: {
  rules: LifecycleRules;
  eventName: string;
  model: string | undefined;
}): LifecycleRules {
  const next = { ...input.rules.startFilters };
  if (input.model?.trim()) {
    next[input.eventName] = input.model;
  } else {
    delete next[input.eventName];
  }

  return writeStartFilters(input.rules, next);
}

/**
 * One Start Filter, written to every Start Event, which is what the collapsed
 * control edits.
 *
 * The same stamp `setConnectionForIntegration` performs for a Connection: one
 * control, several Event keys, because matching still reads the filter per Event
 * name at delivery.
 */
export function setStartFilterForAll(
  rules: LifecycleRules,
  model: string | undefined
): LifecycleRules {
  if (!model?.trim()) {
    return writeStartFilters(rules, {});
  }

  return writeStartFilters(
    rules,
    Object.fromEntries(rules.startEvents.map((eventName) => [eventName, model]))
  );
}

/**
 * The first path in this model the Event does not declare, if there is one.
 *
 * A rule on a path the Event does not carry compiles and evaluates cleanly and
 * reads false on every arrival, because the compiler guards each field for
 * presence. Two callers need the answer: `checkStartFilters` refuses such a
 * filter at publish, and `carryStartFilterToAddedEvents` declines to create one.
 *
 * `$event.name` is a fact about the run rather than a payload path, so it is
 * exempt. An open record is checked at the record itself, since the rule stores
 * the key beside the path rather than in it.
 */
/**
 * Whether `path` is one key of this record rather than something deeper.
 *
 * A record declares the type of one value, so exactly one segment may sit under
 * it. `tags.order` is a key of `tags`; `tags.order.status` is a path through a
 * shape the record never promised.
 */
function keyUnder(recordPath: string, path: string): boolean {
  if (!path.startsWith(`${recordPath}.`)) {
    return false;
  }

  const rest = path.slice(recordPath.length + 1);
  return rest.length > 0 && !rest.includes(".");
}

function unreadableFilterRule(input: {
  model: ConditionModel;
  catalog: ExtensionCatalog;
  eventName: string;
}): string | undefined {
  const payloadFields =
    findEvent(input.catalog, input.eventName)?.payloadFields ?? [];
  const byPath = new Map(payloadFields.map((field) => [field.path, field]));
  // The records among them, whose keys no schema lists.
  const records = payloadFields.filter((field) => field.valueType);

  /**
   * The declaration a rule reads, however the rule stores its path.
   *
   * A rule carrying a `recordKey` names a record and keeps the key beside it, so
   * the base has to be a record: a scalar of the same name reads nothing at
   * `path.key`. An Event that declares the joined form outright answers the same
   * read, which is the second lookup.
   */
  const declarationFor = (rule: ConditionRule) => {
    const path = rule.field.trim();
    const key = rule.recordKey?.trim();

    if (key) {
      const base = byPath.get(path);
      return base?.valueType
        ? base
        : byPath.get(appendOutputPathKey(path, key));
    }

    return (
      byPath.get(path) ?? records.find((record) => keyUnder(record.path, path))
    );
  };

  for (const group of input.model.groups) {
    for (const rule of group.conditions) {
      const path = rule.field.trim();

      // A null check compares nothing, so no declaration and no type can leave
      // it unanswerable.
      if (isNullCheckConditionRule(rule)) {
        continue;
      }

      // The arriving Event's name is a string whatever the payload carries.
      if (path === EVENT_NAME_FIELD_PATH) {
        if (rule.fieldType !== "string") {
          return `compares the arriving Event's name as ${rule.fieldType}, and a name is always text`;
        }
        continue;
      }

      const declaration = declarationFor(rule);
      if (!declaration) {
        return `reads "${path}", which that Event does not carry`;
      }

      // A rule stores the type it was built against, and the compiler emits the
      // operators of that type. A declaration that has since changed type, or
      // that was never something a rule could compare, leaves a rule the payload
      // cannot answer and every arrival refused as unevaluable.
      const offered = conditionTypeOf(declaration);
      if (offered === null) {
        return `compares "${path}", which that Event declares as a shape no rule can compare`;
      }
      if (offered !== rule.fieldType) {
        return `compares "${path}" as ${rule.fieldType}, which that Event now declares as ${offered}`;
      }
    }
  }

  return undefined;
}

/**
 * The Start Filter a collapsed group held, carried onto the Start Events an edit
 * just added.
 *
 * Takes both sides of the edit rather than one, because "has no filter" is a
 * state a builder can also write on purpose: a group the builder split and then
 * cleared one Event of must stay cleared, and only the previous layout can tell
 * the two apart. The panel calls this from the Start Events picker alone.
 */
export function carryStartFilterToAddedEvents(input: {
  previous: LifecycleRules;
  next: LifecycleRules;
  catalog: ExtensionCatalog;
}): LifecycleRules {
  const layout = readStartFilterLayout(input.previous);
  if (!layout.collapsed || !layout.model) {
    return input.next;
  }

  const model = layout.model;
  const parsed = parseConditionModel(model);
  if (!parsed.valid) {
    return input.next;
  }

  // An Event that cannot answer what the filter reads is left unfiltered rather
  // than given a rule that would read false on every one of its arrivals.
  // The group then shows one control per Event, which is the honest picture: the
  // Event that could not take the filter really does start on everything.
  const carried = input.next.startEvents.filter(
    (eventName) =>
      unreadableFilterRule({
        model: parsed.model,
        catalog: input.catalog,
        eventName,
      }) === undefined
  );

  return writeStartFilters(input.next, {
    ...input.next.startFilters,
    ...Object.fromEntries(carried.map((eventName) => [eventName, model])),
  });
}

/**
 * `rules.startFilters`, holding only Events that currently hold the start role.
 *
 * The panel calls this from every setter that can drop a Start Event, so a filter
 * written for an Event that just lost its role does not come back governing runs
 * if that Event is added again later.
 */
export function pruneStartFilters(rules: LifecycleRules): LifecycleRules {
  if (!rules.startFilters) {
    return rules;
  }

  return {
    ...rules,
    startFilters: retainNamedKeys(
      rules.startFilters,
      new Set(rules.startEvents)
    ),
  };
}
